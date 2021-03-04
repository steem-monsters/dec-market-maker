const config = require('./config');
let request = require('request-promise-native');
const SSC = require('sscjs');
const ssc = new SSC(config.ssc.rpc_url);

let hive_price = hbd_price = dec_price = 0;

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
	await loadHivePrice()
	await loadDecPrice();
	setTimeout(loadPrices, 10 * 60 * 1000);
}

async function loadDecPrice() {
	try {
		dec_price = (await convertToHive('DEC', 1)).hive;
		log(`Loaded DEC Price: ${dec_price.toFixed(5)} HIVE`);
	} catch (err) { log(`Error loading DEC price from Hive Engine! Error: ${err}`, 1, 'Red'); }
}

async function loadHivePrice() {
	let btc_data = await request('https://bittrex.com/api/v1.1/public/getticker?market=USD-BTC').catch(err => log(`Error loading BTC price from Bittrex! Error: ${err}`, 1, 'Red'));
	let hive_data = await request('https://bittrex.com/api/v1.1/public/getticker?market=BTC-HIVE').catch(err => log(`Error loading HIVE price from Bittrex! Error: ${err}`, 1, 'Red'));
	let hbd_data = await request('https://bittrex.com/api/v1.1/public/getticker?market=BTC-HBD').catch(err => log(`Error loading HBD price from Bittrex! Error: ${err}`, 1, 'Red'));

	btc_data = tryParse(btc_data);

	if(!btc_data) {
		log('Error parsing BTC price from Bittrex!', 1, 'Red');
		return;
	}

	btc_price = btc_data.result.Bid;
	hive_data = tryParse(hive_data);
	
	if(!hive_data)
		log('Error parsing HIVE price from Bittrex!', 1, 'Red');
	else {
		hive_price = parseFloat(btc_price) * parseFloat(hive_data.result.Bid);
		log(`Loaded HIVE Price: $${hive_price.toFixed(5)}`);
	}

	hbd_data = tryParse(hbd_data);

	if(!hbd_data)
		log('Error parsing HBD price from Bittrex!', 1, 'Red');
	else {
		hbd_price = parseFloat(btc_price) * parseFloat(hbd_data.result.Bid);
		log(`Loaded HBD Price: $${hbd_price.toFixed(5)}`);
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

async function convertToHive(token, token_amount) {
	let pool = await getPoolInfo(token);
	let hive_amount = parseFloat(token_amount) * parseFloat(pool.baseQuantity) / (parseFloat(pool.quoteQuantity) + parseFloat(token_amount));

	let ret_val = { hive: +hive_amount.toFixed(5) };
	ret_val[token] = +token_amount.toFixed(3);

	return ret_val;
}

async function convertFromHive(token, hive_amount) {
	let pool = await getPoolInfo(token);
	let token_amount = parseFloat(hive_amount) * parseFloat(pool.quoteQuantity) / (parseFloat(pool.baseQuantity) + parseFloat(hive_amount));

	let ret_val = { hive: +hive_amount.toFixed(3) };
	ret_val[token] = +token_amount.toFixed(3);

	return ret_val;
}

async function getPoolInfo(token) {
	return await ssc.findOne('marketpools', 'pools', { tokenPair: `SWAP.HIVE:${token}` });

	/*
		basePrice: "439.59798574" - DEC / HIVE
		baseQuantity: "49089.44612205" - HIVE in Pool
		baseVolume: "35474.77449567"
		creator: "sm-usd"
		precision: 8
		quotePrice: "0.00227480" - HIVE / DEC
		quoteQuantity: "21579621.63656238" - DEC in Pool
		quoteVolume: "15285617.26143738"
		tokenPair: "SWAP.HIVE:DEC"
		totalShares: "1029238.39479294015642316074"
	*/
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
	convertToHive,
	convertFromHive,
	getCurrency,
	getDecBalance,
	checkSETransaction,
	getSETokenBalance,
	decPrice: () => dec_price,
	hivePrice: () => hive_price,
	hbdPrice: () => hbd_price
}