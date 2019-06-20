const fs = require("fs");
const utils = require('./utils');
const config = require('./config');
var steem_interface = require('./steem-interface');

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

	await utils.loadPrices();

	getNextBlock();
}

async function getNextBlock() {
	var result = await steem_interface.database('get_dynamic_global_properties');

	if(!result) {
		setTimeout(getNextBlock, 1000);
		return;
	}

	if(last_block == 0)
		last_block = result.head_block_number - 1;

	// We are 20+ blocks behind!
	if(result.head_block_number >= last_block + 20)
		utils.log('Steem Monsters node is ' + (result.head_block_number - last_block) + ' blocks behind!', 1, 'Red');

	// If we have a new block, process it
	while(result.head_block_number > last_block)
		await processBlock(last_block + 1);

	// Attempt to load the next block after a 1 second delay (or faster if we're behind and need to catch up)
	setTimeout(getNextBlock, 1000);
}

async function processBlock(block_num) {
	var block = await steem_interface.database('get_block', [block_num]);

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

			var data = utils.tryParse(op[1].memo);

			if(!data || data.method != 'buy' || data.symbol != 'DEC')
				return;	// Optionally refund the payment here

			let to = data.to ? data.to : op[1].from;
			let amount = parseFloat(op[1].amount);
			let currency = utils.getCurrency(op[1].amount);

			if(currency == 'SBD')
				return; // Optionally refund the payment here

			let conversion = await utils.convertSteemDec(amount);

			if(conversion.steem < amount) {
				// TODO: Not enough DEC available for sale, refund remaining STEEM
			}

			let dec_amount_net_fee = +(conversion.dec * (1 - config.fee_pct / 10000)).toFixed(3);

			let dec_balance = await utils.getDecBalance();

			utils.log(`DEC Balance: ${dec_balance}`);

			if(dec_balance < dec_amount_net_fee) {
				// TODO: Insufficient balance, refund payment
				return;
			}

			// Transfer the DEC minus the conversion fee
			steem_interface.queue_custom_json('sm_token_transfer', { to: to, qty: dec_amount_net_fee, token: 'DEC' });

			// Deposit STEEM to Steem Engine, buy DEC, and withdraw it back to the game
			marketBuy(amount, dec_amount_net_fee);
		} catch(err) {
			console.log(err);
		}
	}
}

async function marketBuy(steem_amount, dec_amount) {
	try {
		// Deposit STEEM to Steem Engine
		let deposit = await steem_interface.transfer(
			config.ssc.steemp_account, 
			`${steem_amount.toFixed(3)} STEEM`, 
			`{"id":"${config.ssc.chain_id}","json":{"contractName":"steempegged","contractAction":"buy","contractPayload":{}}}`
		);

		if(!deposit || !deposit.id) {
			utils.log(`Deposit of [${steem_amount} STEEM] failed!`, 1, 'Red');
			return;
		}

		// Make sure the transaction went through
		let deposit_result = await utils.checkSETransaction(deposit.id);

		if(!deposit_result || !deposit_result.success) {
			utils.log(`Deposit of [${steem_amount} STEEM] failed! Error: ${deposit_result.error}`, 1, 'Red');
			return;
		}

		let deposit_logs = utils.tryParse(deposit_result.logs);
		let deposit_amount = parseFloat(deposit_logs.events[0].data.quantity);

		let purchase_price = (deposit_amount / dec_amount).toFixed(5);

		// Place the market buy order
		let market_buy = await steem_interface.queue_custom_json(config.ssc.chain_id, {
			"contractName":"market",
			"contractAction":"buy",
			"contractPayload": {
				"symbol": "DEC",
				"quantity": dec_amount.toFixed(3),
				"price": purchase_price
			}
		}, true);

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
		let dec_transfer = await steem_interface.queue_custom_json(config.ssc.chain_id, {
			"contractName":"tokens",
			"contractAction":"transfer",
			"contractPayload": {
				"symbol": "DEC",
				"quantity": dec.toFixed(3),
				"to": config.sm_account
			}
		}, true);

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