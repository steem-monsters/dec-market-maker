const fs = require("fs");
const utils = require('./utils');
const config = require('./config');
var express = require('express');
var app = express();
const interface = require('@splinterlands/hive-interface');
const hive = new interface.Hive({ rpc_nodes: config.rpc_nodes });

let last_block = 0;

start();

async function start() {
	// Check if state has been saved to disk, in which case load it
	if (fs.existsSync('state.json')) {
		var state = JSON.parse(fs.readFileSync("state.json"));

		if (state.last_block)
			last_block = state.last_block;

		utils.log('Restored saved state: ' + JSON.stringify(state));
	}

	getNextBlock();
}

app.use(function(req, res, next) {
	res.header("Access-Control-Allow-Origin", "*");
	res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, X-CSRF-Token, Content-Type, Accept");
	res.header("X-Frame-Options", "sameorigin")
	next();
});

if (config.api_port) {
	app.listen(config.api_port, () => utils.log('API running on port: ' + config.api_port));
}

app.get('/conversion_rate', async (req, res) => {
	const from_token = (req.query.from_token || '').toUpperCase();
	const to_token = (req.query.to_token || '').toUpperCase();

	if(from_token !== 'HIVE' && !config.supported_tokens.includes(from_token))
		return res.json({ error: 'Missing or invalid "from_token" specified.' });

	if(to_token !== 'HIVE' && !config.supported_tokens.includes(to_token))
		return res.json({ error: 'Missing or invalid "to_token" specified.' });

	if(from_token === to_token || (from_token !== 'HIVE' && to_token !== 'HIVE'))
		return res.json({ error: 'Must convert a token to HIVE or HIVE to another token.' });

	const amount = parseFloat(req.query.amount);

	if(!amount || isNaN(amount))
		return res.json({ error: 'Missing or invalid "amount" property.' });

	if(from_token === 'HIVE') {
		const ret_val = (await utils.convertFromHive(to_token, amount));
		ret_val[to_token] = +(ret_val[to_token] * (1 - config.fee_pct / 10000)).toFixed(3);
		return res.json(ret_val);
	} else {
		const ret_val = (await utils.convertToHive(from_token, amount));
		ret_val['HIVE'] = +(ret_val['HIVE'] * (1 - config.fee_pct / 10000)).toFixed(3);
		return res.json(ret_val);
	}
});

async function getNextBlock() {
	try {
		var result = await hive.api('get_dynamic_global_properties');

		if(!result) {
			setTimeout(getNextBlock, 1000);
			return;
		}

		let head_block = result.head_block_number - (config.blocks_behind_head || 0);

		if(last_block == 0)
			last_block = head_block - 1;

		// We are 20+ blocks behind!
		if(head_block >= last_block + 20)
			utils.log('Service is ' + (head_block - last_block) + ' blocks behind!', 1, 'Red');

		// If we have a new block, process it
		while(head_block > last_block)
			await processBlock(last_block + 1);

	} catch(err) { utils.log(`Error getting next block: ${err}`, 1, 'Red'); }

	// Attempt to load the next block after a 1 second delay (or faster if we're behind and need to catch up)
	setTimeout(getNextBlock, 1000);
}

async function processBlock(block_num) {
	var block = await hive.api('get_block', [block_num]);

	// Log every 1000th block loaded just for easy parsing of logs, or every block depending on logging level
	utils.log('Processing block [' + block_num + ']...', block_num % 1000 == 0 ? 1 : 4);

	if(!block || !block.transactions) {
		// Block couldn't be loaded...this is typically because it hasn't been created yet
		utils.log('Error loading block [' + block_num + ']', 4);
		await utils.timeout(1000);
		return;
	}

	var block_time = new Date(block.timestamp + 'Z');

	// Loop through all of the transactions and operations in the block
	for(var i = 0; i < block.transactions.length; i++) {
		var trans = block.transactions[i];

		for(var op_index = 0; op_index < trans.operations.length; op_index++) {
			var op = trans.operations[op_index];
			await processOp(op, block_num, block.block_id, block.previous, block.transaction_ids[i], block_time);
		}
	}

	last_block = block_num;
	saveState();
}

async function processOp(op, block_num, block_id, prev_block_id, trx_id, block_time) {
	// Process the operation
	if(op[0] == 'transfer' && op[1].to == config.account) {
		try {
			utils.log("Incoming Payment! From: " + op[1].from + ", Amount: " + op[1].amount + ", memo: " + op[1].memo);

			let data = null;

			if(op[1].memo.startsWith('{'))
				data = utils.tryParse(op[1].memo);
			else {
				if(op[1].memo[op[1].memo.length - 1] != '=')
					op[1].memo = op[1].memo + '='
					
				data = utils.tryParse(new Buffer(op[1].memo, 'base64').toString('ascii'))
			}

			if(!data || data.method != 'buy' || !config.supported_tokens.includes(data.symbol))
				return;	// Optionally refund the payment here

			let to = data.to ? data.to : (data.id ? data.id : op[1].from);
			let amount = parseFloat(op[1].amount);
			let currency = utils.getCurrency(op[1].amount);

			if(currency == 'HBD')
				return; // Optionally refund the payment here

			let conversion = await utils.convertFromHive(data.symbol, amount);

			if(conversion.HIVE < amount) {
				// Not enough DEC available for sale, refund remaining HIVE
				await hive.transfer(config.account, to, `${(amount - conversion.HIVE).toFixed(3)} HIVE`, `Not enough ${data.symbol} available for purchase. Refunding remaining HIVE.`, config.active_key);
			}

			let dec_amount_net_fee = +(conversion[data.symbol] * (1 - config.fee_pct / 10000)).toFixed(3);
			let dec_balance = await utils.getInGameBalance(data.symbol);

			utils.log(`DEC Balance: ${dec_balance}`);

			if(dec_balance < dec_amount_net_fee) {
				// Insufficient balance, refund payment
				utils.log(`Insufficient ${data.symbol} balance [${dec_balance}]!`, 1, 'Red');
				await hive.transfer(config.account, to, op[1].amount, `Insufficient ${data.symbol} balance. Refunding payment.`, config.active_key);
				return;
			}

			// Transfer the tokens minus the conversion fee
			hive.custom_json(`${config.prefix}token_transfer`, { to: to, qty: dec_amount_net_fee, token: data.symbol }, config.account, config.active_key, true);

			// Deposit HIVE to Hive Engine, buy DEC, and withdraw it back to the game
			poolBuy(amount, data.symbol);
		} catch(err) {
			console.log(err);
		}
	}
}

async function poolBuy(amount, symbol) {
	try {
		// Deposit HIVE to Hive Engine
		let deposit = await hive.transfer(
			config.account,
			config.ssc.deposit_account, 
			`${amount.toFixed(3)} HIVE`, 
			`{"id":"${config.ssc.chain_id}","json":{"contractName":"hivepegged","contractAction":"buy","contractPayload":{}}}`,
			config.active_key
		);

		if(!deposit || !deposit.id) {
			utils.log(`Deposit of [${amount} HIVE] failed!`, 1, 'Red');
			return;
		}

		// Make sure the transaction went through
		let deposit_result = await utils.checkSETransaction(deposit.id);

		if(!deposit_result || !deposit_result.success) {
			utils.log(`Deposit of [${amount} HIVE] failed! Error: ${deposit_result.error}`, 1, 'Red');
			return;
		}

		const wait_time = Math.random() * ((config.max_time || 60) * 1000) + ((config.min_time || 5) * 1000);
		utils.log(`Waiting ${(wait_time / 1000).toFixed(2)} seconds before continuing...`)

		// Wait a random amount of time before buying from market to reduce front-running
		await utils.timeout(wait_time);

		// Do the swap
		let pool_swap = await hive.custom_json(config.ssc.chain_id, {
			"contractName": "marketpools",
			"contractAction": "swapTokens",
			"contractPayload": {
				"tokenPair": `SWAP.HIVE:${symbol}`,
				"tokenSymbol": "SWAP.HIVE",
				"tokenAmount": amount.toFixed(3),
				"tradeType": "exactInput",
				"maxSlippage": "10"
			}
		}, config.account, config.active_key, true);

		if(!pool_swap || !pool_swap.id) {
			utils.log(`Diesel pool swap of [${amount} HIVE] failed!`, 1, 'Red');
			return;
		}

		// Make sure the transaction went through
		let swap_result = await utils.checkSETransaction(pool_swap.id);

		if(!swap_result || !swap_result.success) {
			utils.log(`Diesel pool swap of [${amount} HIVE] failed! Error: ${swap_result.error}`, 1, 'Red');
			return;
		}

		// Find the amount of tokens received from the market
		let market_logs = utils.tryParse(swap_result.logs);
		let dec = market_logs.events.filter(e => e.data.to == config.account).reduce((t, v) => t + parseFloat(v.data.quantity), 0);

		// Finally, transfer the tokens back to the game account
		let dec_transfer = await hive.custom_json(config.ssc.chain_id, {
			"contractName":"tokens",
			"contractAction":"transfer",
			"contractPayload": {
				"symbol": symbol,
				"quantity": dec.toFixed(3),
				"to": config.sm_account
			}
		}, config.account, config.active_key, true);

		if(!dec_transfer || !dec_transfer.id) {
			utils.log(`Transfer of [${dec} ${symbol}] to @${config.sm_account} failed!`, 1, 'Red');
			return;
		}
		
		// Make sure the transaction went through
		let dec_transfer_result = await utils.checkSETransaction(dec_transfer.id);

		if(!dec_transfer_result || !dec_transfer_result.success) {
			utils.log(`Transfer of [${dec} ${symbol}] to @${config.sm_account} failed! Error: ${dec_transfer_result.error}`, 1, 'Red');
			return;
		}
	} catch(err) {
		console.log(err);
	}
}

async function marketBuy(amount, dec_amount) {
	try {
		// Deposit HIVE to Hive Engine
		let deposit = await hive.transfer(
			config.account,
			config.ssc.deposit_account, 
			`${amount.toFixed(3)} HIVE`, 
			`{"id":"${config.ssc.chain_id}","json":{"contractName":"hivepegged","contractAction":"buy","contractPayload":{}}}`,
			config.active_key
		);

		if(!deposit || !deposit.id) {
			utils.log(`Deposit of [${amount} HIVE] failed!`, 1, 'Red');
			return;
		}

		// Make sure the transaction went through
		let deposit_result = await utils.checkSETransaction(deposit.id);

		if(!deposit_result || !deposit_result.success) {
			utils.log(`Deposit of [${amount} HIVE] failed! Error: ${deposit_result.error}`, 1, 'Red');
			return;
		}

		let deposit_logs = utils.tryParse(deposit_result.logs);
		let deposit_amount = parseFloat(deposit_logs.events[0].data.quantity);

		let purchase_price = (deposit_amount / dec_amount).toFixed(5);

		// Place the market buy order
		let market_buy = await hive.custom_json(config.ssc.chain_id, {
			"contractName":"market",
			"contractAction":"buy",
			"contractPayload": {
				"symbol": "DEC",
				"quantity": dec_amount.toFixed(3),
				"price": purchase_price
			}
		}, config.account, config.active_key, true);

		if(!market_buy || !market_buy.id) {
			utils.log(`Market buy of [${dec_amount} DEC] failed!`, 1, 'Red');
			return;
		}

		// Make sure the transaction went through
		let market_result = await utils.checkSETransaction(market_buy.id);

		if(!market_result || !market_result.success) {
			utils.log(`Market buy of [${dec_amount} DEC] failed! Error: ${market_result.error}`, 1, 'Red');
			return;
		}

		// Find the amount of DEC received from the market
		let market_logs = utils.tryParse(market_result.logs);
		let dec = market_logs.events.filter(e => e.data.to == config.account).reduce((t, v) => t + parseFloat(v.data.quantity), 0);

		// Finally, transfer the DEC back to the game account
		let dec_transfer = await hive.custom_json(config.ssc.chain_id, {
			"contractName":"tokens",
			"contractAction":"transfer",
			"contractPayload": {
				"symbol": "DEC",
				"quantity": dec.toFixed(3),
				"to": config.sm_account
			}
		}, config.account, config.active_key, true);

		if(!dec_transfer || !dec_transfer.id) {
			utils.log(`Transfer of [${dec} DEC] to @${config.sm_account} failed!`, 1, 'Red');
			return;
		}
		
		// Make sure the transaction went through
		let dec_transfer_result = await utils.checkSETransaction(dec_transfer.id);

		if(!dec_transfer_result || !dec_transfer_result.success) {
			utils.log(`Transfer of [${dec_amount} DEC] to @${config.sm_account} failed! Error: ${dec_transfer_result.error}`, 1, 'Red');
			return;
		}
	} catch(err) {
		console.log(err);
	}
}

function saveState() {
  var state = {
		last_block: last_block
  };

  // Save the state of the bot to disk
  fs.writeFile('state.json', JSON.stringify(state), function (err) {
    if (err)
      utils.log(err);
  });
}