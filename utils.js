const config = require('./config');
let request = require('request-promise-native');
const SSC = require('sscjs');
const ssc = new SSC(config.ssc.rpc_url);

let steem_price = sbd_price = dec_price = 0;

// Logging levels: 1 = Error, 2 = Warning, 3 = Info, 4 = Debug
function log(msg, level, color) { 
  if(!level)
		level = 0;
		
	if(color && log_colors[color])
		msg = log_colors[color] + msg + log_colors.Reset;

  if(level <= config.logging_level)
    console.log(new Date().toString() + ' - ' + msg); 
}

var log_colors = {
	Reset: "\x1b[0m",
	Bright: "\x1b[1m",
	Dim: "\x1b[2m",
	Underscore: "\x1b[4m",
	Blink: "\x1b[5m",
	Reverse: "\x1b[7m",
	Hidden: "\x1b[8m",

	Black: "\x1b[30m",
	Red: "\x1b[31m",
	Green: "\x1b[32m",
	Yellow: "\x1b[33m",
	Blue: "\x1b[34m",
	Magenta: "\x1b[35m",
	Cyan: "\x1b[36m",
	White: "\x1b[37m",

	BgBlack: "\x1b[40m",
	BgRed: "\x1b[41m",
	BgGreen: "\x1b[42m",
	BgYellow: "\x1b[43m",
	BgBlue: "\x1b[44m",
	BgMagenta: "\x1b[45m",
	BgCyan: "\x1b[46m",
	BgWhite: "\x1b[47m"
}

function timeout(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function getCurrency(amount) { return amount.substr(amount.indexOf(' ') + 1); }

async function loadPrices() {
	await loadSteemPrice()
	await loadDecPrice();
	setTimeout(loadPrices, 10 * 60 * 1000);
}

async function loadDecPrice() {
	let dec_data = await ssc.findOne('market', 'metrics', { symbol: 'DEC' }).catch(err => log(`Error loading DEC price from SE! Error: ${err}`, 1, 'Red'));
	dec_price = parseFloat(dec_data.lastPrice);
	log(`Loaded DEC Price: ${dec_price.toFixed(5)} STEEM`);
}

async function loadSteemPrice() {
	let btc_data = await request('https://bittrex.com/api/v1.1/public/getticker?market=USD-BTC').catch(err => log(`Error loading BTC price from Bittrex! Error: ${err}`, 1, 'Red'));
	let steem_data = await request('https://bittrex.com/api/v1.1/public/getticker?market=BTC-STEEM').catch(err => log(`Error loading STEEM price from Bittrex! Error: ${err}`, 1, 'Red'));
	let sbd_data = await request('https://bittrex.com/api/v1.1/public/getticker?market=BTC-SBD').catch(err => log(`Error loading SBD price from Bittrex! Error: ${err}`, 1, 'Red'));

	btc_data = tryParse(btc_data);

	if(!btc_data) {
		log('Error parsing BTC price from Bittrex!', 1, 'Red');
		return;
	}

	btc_price = btc_data.result.Bid;
	steem_data = tryParse(steem_data);
	
	if(!steem_data)
		log('Error parsing STEEM price from Bittrex!', 1, 'Red');
	else {
		steem_price = parseFloat(btc_price) * parseFloat(steem_data.result.Bid);
		log(`Loaded STEEM Price: $${steem_price.toFixed(5)}`);
	}

	sbd_data = tryParse(sbd_data);

	if(!sbd_data)
		log('Error parsing SBD price from Bittrex!', 1, 'Red');
	else {
		sbd_price = parseFloat(btc_price) * parseFloat(sbd_data.result.Bid);
		log(`Loaded SBD Price: $${sbd_price.toFixed(5)}`);
	}
}

let sell_books = {};
async function getSellBook(token) {
	let sell_book = sell_books[token] || {};

	if(!sell_book.date_loaded || sell_book.date_loaded < Date.now() - 60 * 1000) {
		sell_book.date_loaded = Date.now();
		sell_book.orders = await ssc.find('market', 'sellBook', { symbol: token }, 200, 0, [{ index: 'priceDec', descending: false }], false);
	}

	return sell_book.orders;
}

async function convertToSteem(token, desired_quantity) {
	let token_amount = 0, steem = 0, index = -1;
	let sell_orders = await getSellBook(token);

	while(token_amount < desired_quantity && ++index < sell_orders.length) {
		let order = sell_orders[index];
		let qty = Math.min(desired_quantity - token_amount, parseFloat(order.quantity));
		steem += qty * parseFloat(order.price);
		token_amount += qty;
	}

	let ret_val = { steem: +steem.toFixed(3) };
	ret_val[token] = +token_amount.toFixed(3);

	return ret_val;
}

async function convertFromSteem(token, desired_quantity) {
	let token_amount = 0, steem = 0, index = -1;
	let sell_orders = await getSellBook(token);

	while(steem < desired_quantity && ++index < sell_orders.length) {
		let order = sell_orders[index];
		let qty = Math.min(desired_quantity - steem, parseFloat(order.quantity) * parseFloat(order.price));
		steem += qty;
		token_amount += qty / parseFloat(order.price);
	}

	let ret_val = { steem: +steem.toFixed(3) };
	ret_val[token] = +token_amount.toFixed(3);

	return ret_val;
}

async function getDecBalance() {
	let balances = await request(`${config.sm_api_url}/players/balances?username=${config.account}`).catch(err => log(`Error loading DEC balances from SM API! Error: ${err}`, 1, 'Red'));

	balances = tryParse(balances);

	let dec_balance = balances.find(b => b.token == 'DEC');
	return dec_balance ? dec_balance.balance : 0;
}

function tryParse(json) {
	try {
		return JSON.parse(json);
	} catch(err) {
		log('Error trying to parse JSON: ' + json, 3, 'Red');
		return null;
	}
}

async function checkSETransaction(trx_id, retries) {
	if(!retries)
		retries = 0;

	return await ssc.getTransactionInfo(trx_id).then(async result => {
		if(result) {
			var error = null;

			if(result.logs) {
				var logs = JSON.parse(result.logs);

				if(logs.errors && logs.errors.length > 0)
					error = logs.errors[0];
			}

			return Object.assign(result, { error: error, success: !error });
		} else if(retries < 6) {
			await timeout(5000);
			return await checkSETransaction(trx_id, retries + 1);
		} else
			return { success: false, error: 'Transaction not found.' };
	});
}

async function getSETokenBalance(symbol) {
	let balance = ssc.findOne('tokens', 'balances', { symbol: symbol, account: config.account });
	return balance ? parseFloat(balance.balance) : 0;
}

module.exports = {
	log,
	timeout,
	tryParse,
	loadPrices,
	convertToSteem,
	convertFromSteem,
	getCurrency,
	getDecBalance,
	checkSETransaction,
	getSETokenBalance,
	decPrice: () => dec_price,
	steemPrice: () => steem_price,
	sbdPrice: () => sbd_price
}