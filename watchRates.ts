import { Client, AccountLinesRequest, AccountOffersRequest, OfferCreate, Wallet, OfferCancel, OfferCreateFlags, AccountOffer, dropsToXrp, xrpToDrops, Payment, SubscribeRequest, TransactionStream, AccountLinesResponse, AccountLinesTrustline } from 'xrpl';
import { XrplClient } from 'xrpl-client';
import { scheduleJob } from 'node-schedule';
import * as fetch from 'node-fetch';
import { isCreatedNode } from 'xrpl/dist/npm/models/transactions/metadata';
import * as fs from 'fs';
import 'log-timestamp';

let livenetClient = new XrplClient();
let testnetClient = new XrplClient(process.env.XRPL_SERVER || 'ws://127.0.0.1:6006');
let seed:string = process.env.ACCOUNT_SEED || '';
let wallet = Wallet.fromSeed(seed);
let latestLiveRates:Map<string, number> = new Map();
let submitClient = new Client(process.env.XRPL_SERVER || 'ws://127.0.0.1:6006');
let sendTokensClient = new Client(process.env.XRPL_SERVER || 'ws://127.0.0.1:6006');
let networkId = process.env.NETWORK_ID ? Number(process.env.NETWORK_ID) : null;
let sellWallAmountInXrp:number = 100000;

let supportedApiCurrencies:string[] = ['BNB','BTC','CYN'];

async function start() {
    console.log("wallet: " , wallet);
    console.log("networkId: " + networkId);

    if(fs.existsSync("../apiCurrencies")) {
        let currencies = JSON.parse(fs.readFileSync("../apiCurrencies").toString());

        if(currencies && currencies.supported) {
            supportedApiCurrencies = currencies.supported;
        }
    }

    await watchLiveRates();
    await checkOffers();

    let subscribeAccount:SubscribeRequest = {
        command: 'subscribe',
        accounts: [wallet.classicAddress]
    }

    testnetClient.on('transaction', trx => {
        handleIncomingTrustline(trx);
    });

    await testnetClient.send(subscribeAccount);

    scheduleJob('xrplLiveRateOracle', { second: 0 } , () => watchLiveRates());
    scheduleJob('checkOffers', { second: 10 } , () => checkOffers());

    console.log("watching... check the ledger!")
}

async function watchLiveRates() {

    //console.log("GETTING LIVE RATES");

    try {

        //console.log("calling XRPL...")

        let accountLinesRequest:AccountLinesRequest = {
            command: 'account_lines',
            account: 'rpXCfDds782Bd6eK9Hsn15RDnGMtxf752m',
            limit: 400
        }

        let accountLinesResponse:any = await livenetClient.send(accountLinesRequest);
        //console.log(accountLinesResponse);

        if(accountLinesResponse) {

            if(accountLinesResponse?.lines.length > 0) {
                //console.log("FOUND LINES!");

                let trustlines:AccountLinesTrustline[] = accountLinesResponse.lines;
                for(let i = 0; i < trustlines.length; i++) {
                    let currency:string = trustlines[i].currency;
                    let rate:number = Math.abs(Number(trustlines[i].limit));

                    //console.log("adding rate: " + currency + " | " + rate);

                    latestLiveRates.set(currency, rate);
                }

                //console.log("oracle data updated");
            }
        }
    } catch(err) {
        console.log("ERR CALLING XRPL");
        console.log(err);
    }

    try {
        //console.log("Calling coingecko...")

        let fetchResponse = await fetch.default("https://api.coingecko.com/api/v3/coins/ripple?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false");

        if(fetchResponse && fetchResponse.ok) {
            let parsedResponse = await fetchResponse.json();            

            if(parsedResponse && parsedResponse["market_data"]) {
                let marketData = parsedResponse["market_data"];

                let currentPrice = marketData["current_price"];

                let apiSupported:string[] = [];
                for(let i = 0; i < supportedApiCurrencies.length; i++) {
                    let hurmanReadable = normalizeCurrencyCodeXummImpl(supportedApiCurrencies[i]);
                    if(currentPrice[hurmanReadable.toLowerCase()]) {
                        //console.log("adding rate: " + "BNB" + " | " + currentPrice['bnb']);
                        latestLiveRates.set(supportedApiCurrencies[i], currentPrice[hurmanReadable.toLowerCase()]);

                        apiSupported.push(supportedApiCurrencies[i]);
                    }
                }

                if(supportedApiCurrencies.length != apiSupported.length) {
                    fs.writeFileSync("./apiCurrencies", JSON.stringify({supported: apiSupported}));
                }
            }

            //console.log("coingecko data updated");
        }
    } catch(err) {
        console.log("err calling coingecko");
        console.log(err);
    }
}

async function checkOffers() {
    let accountOfferRequest:AccountOffersRequest = {
        command: 'account_offers',
        account: wallet.classicAddress,
        limit: 400
    }

    let accountOffersResponse:any = await testnetClient.send(accountOfferRequest);

    if(accountOffersResponse) {

        if(accountOffersResponse?.offers) {
            let offers:AccountOffer[] = accountOffersResponse.offers;

            if(submitClient && !submitClient.isConnected()) {
                await submitClient.connect();
            }

            //check for live rates without offers and create them
            for(let currencyKey of latestLiveRates.keys()) {
                //check for sell offers
                //console.log("CHECKING currency: " + currencyKey);

                let liveRate = latestLiveRates.get(currencyKey);

                if(liveRate) {

                    try {

                        //check for sell offer!
                        let createNewOffers:boolean = true;
                        let lowXrpOfferAmount:boolean = false;
                        let oldSellOffersToDelete:number[] = [];
                        let oldBuyOffersToDelete:number[] = [];

                        for(let i = 0; i < offers.length;i++) {
                            let singleOffer = offers[i];
                            if(typeof singleOffer.taker_gets === 'object' && typeof singleOffer.taker_pays === 'string') {

                                //SELL OFFER

                                let offerXrpAmount = Number(dropsToXrp(singleOffer.taker_pays));

                                if(currencyKey === singleOffer.taker_gets.currency) {
                                    let offerRate = Number((Number(singleOffer.quality)/1000000).toFixed(12));
                                    let convertedLiveRate = 1/liveRate;

                                    //console.log("currency: " + currencyKey);
                                    //console.log("offer rate: " + offerRate);
                                    //console.log("convertedLiveRate: " + convertedLiveRate);

                                    let diff = Math.abs((offerRate * 100 / convertedLiveRate) - 100)

                                    //console.log("diff: " + diff);

                                    oldSellOffersToDelete.push(singleOffer.seq);

                                    if(diff <=2) {
                                        //console.log("diff: " + diff);
                                        createNewOffers = false;
                                    }

                                    if(offerXrpAmount < (sellWallAmountInXrp/2)) {
                                        console.log(currencyKey+": SELL offerXrpAmount: " + offerXrpAmount);
                                        lowXrpOfferAmount = true;
                                    }

                                }
                            }

                            if(typeof singleOffer.taker_pays === 'object' && typeof singleOffer.taker_gets === 'string') {

                                //BUY OFFER

                                let offerXrpAmount = Number(dropsToXrp(singleOffer.taker_gets));

                                if(currencyKey === singleOffer.taker_pays.currency) {
                                    oldBuyOffersToDelete.push(singleOffer.seq);

                                    if(offerXrpAmount < (sellWallAmountInXrp/2)) {
                                        console.log(currencyKey+": BUY offerXrpAmount: " + offerXrpAmount);
                                        lowXrpOfferAmount = true;
                                    }
                                }
                            }
                        }

                        if(createNewOffers || oldSellOffersToDelete.length > 1 || oldBuyOffersToDelete.length > 1 || lowXrpOfferAmount) { //no sell offer found. create it!
                            console.log("CREATING NEW OFFERS FOR " + currencyKey);
                            await sleep(500);
                            if(oldSellOffersToDelete.length > 0) {
                                await createSellOffer(currencyKey, liveRate*0.995, oldSellOffersToDelete[0]);
                                oldSellOffersToDelete.shift();
                            } else {
                                await createSellOffer(currencyKey, liveRate*0.995);
                            }

                            await sleep(500);

                            if(oldBuyOffersToDelete.length > 0) {
                                await createBuyOffer(currencyKey, liveRate*1.005, oldBuyOffersToDelete[0]);
                                oldBuyOffersToDelete.shift();
                            } else {
                                await createBuyOffer(currencyKey, liveRate*1.005)
                            }

                            if(oldSellOffersToDelete && oldSellOffersToDelete.length > 0) {
                                console.log("DELETING OLD SELL OFFERS");
                                await sleep(500);
                                for(let j = 0; j < oldSellOffersToDelete.length; j++) {
                                    await cancelOldOffer(oldSellOffersToDelete[j]);
                                }
                            }

                            if(oldBuyOffersToDelete && oldBuyOffersToDelete.length > 0) {
                                console.log("DELETING OLD BUY OFFERS");
                                await sleep(500);
                                for(let j = 0; j < oldBuyOffersToDelete.length; j++) {
                                    await cancelOldOffer(oldBuyOffersToDelete[j]);
                                }
                            }
                        }
                    } catch(err) {
                        console.log(err);
                        console.log(JSON.stringify(err));
                    }                   
                }
            }

            submitClient.disconnect();
        }
    }
}

async function createSellOffer(currency:string, rate:number, oldOfferSequence?: number) {

    let normalizedValue = normalizeBalance(sellWallAmountInXrp*rate);

    console.log("SELL: " + normalizedValue);

    let newOffer:OfferCreate = {
        TransactionType: "OfferCreate",
        Account: wallet.classicAddress,
        TakerGets: {
            currency: currency,
            issuer: wallet.classicAddress,
            value: normalizedValue
        },
        TakerPays: xrpToDrops(sellWallAmountInXrp),
        Flags: OfferCreateFlags.tfSell
    }

    if(networkId) {
        newOffer.NetworkID = networkId;
    }

    if(oldOfferSequence && oldOfferSequence > 0) {
        newOffer.OfferSequence = oldOfferSequence;
    }

    let submitResponse = await submitClient.submit(newOffer, {wallet: wallet, autofill: true})

    if(!submitResponse || !submitResponse.result || submitResponse.result.engine_result != 'tesSUCCESS') {
        //try again!
        submitResponse = await submitClient.submit(newOffer, {wallet: wallet, autofill: true})

        if(!submitResponse || !submitResponse.result || submitResponse.result.engine_result != 'tesSUCCESS') {
            console.log(JSON.stringify(submitResponse));
            console.log(newOffer);
        }
    }

    //console.log("SELL:")
    //console.log(submitResponse);
}

async function createBuyOffer(currency:string, rate:number, oldOfferSequence?: number) {

    let normalizedValue = normalizeBalance(sellWallAmountInXrp*rate);

    console.log("BUY: " + normalizedValue);

    let newOffer:OfferCreate = {
        TransactionType: "OfferCreate",
        Account: wallet.classicAddress,
        TakerPays: {
            currency: currency,
            issuer: wallet.classicAddress,
            value: normalizedValue
        },
        TakerGets: xrpToDrops(100000)
    }

    if(networkId) {
        newOffer.NetworkID = networkId;
    }

    if(oldOfferSequence && oldOfferSequence > 0) {
        newOffer.OfferSequence = oldOfferSequence;
    }

    let submitResponse = await submitClient.submit(newOffer, {wallet: wallet, autofill: true})

    if(!submitResponse || !submitResponse.result || submitResponse.result.engine_result != 'tesSUCCESS') {
        //try again!
        submitResponse = await submitClient.submit(newOffer, {wallet: wallet, autofill: true})

        if(!submitResponse || !submitResponse.result || submitResponse.result.engine_result != 'tesSUCCESS') {
            console.log(JSON.stringify(submitResponse));
            console.log(newOffer);
        }
    }

    //console.log("BUY:")
    //console.log(submitResponse);
}

async function cancelOldOffer(sequence:number) {
    //and now cancel old offer!
    let offerCancel:OfferCancel = {
        TransactionType: "OfferCancel",
        Account: wallet.classicAddress,
        OfferSequence: sequence
    }

    if(networkId) {
        offerCancel.NetworkID = networkId;
    }

    let cancelOfferSubmit = await submitClient.submit(offerCancel, {wallet: wallet, autofill: true});

    if(!cancelOfferSubmit || !cancelOfferSubmit.result || cancelOfferSubmit.result.engine_result != 'tesSUCCESS') {
        //try again!
        cancelOfferSubmit = await submitClient.submit(offerCancel, {wallet: wallet, autofill: true})

        if(!cancelOfferSubmit || !cancelOfferSubmit.result || cancelOfferSubmit.result.engine_result != 'tesSUCCESS') {
            console.log(JSON.stringify(cancelOfferSubmit));
            console.log(offerCancel);
        }
    }
}

async function handleIncomingTrustline(transaction:any) {

    try {
        if(transaction) {
            let parsedTrx:TransactionStream = transaction;

            if(parsedTrx.engine_result === 'tesSUCCESS' && parsedTrx.transaction.TransactionType === 'TrustSet') {
                if(parsedTrx.meta && typeof parsedTrx.meta === 'object') {

                    console.log(JSON.stringify(parsedTrx));

                    let meta = parsedTrx.meta;
                    let affectedNodes = meta.AffectedNodes;

                    for(let i = 0; i < affectedNodes.length-1; i++) {
                        let singleNode = affectedNodes[i];

                        if(singleNode && isCreatedNode(singleNode)) {
                            if(singleNode.CreatedNode.LedgerEntryType === 'RippleState' && singleNode.CreatedNode.NewFields.Balance && typeof singleNode.CreatedNode.NewFields.Balance === 'object') {
                                let newFields:any = singleNode.CreatedNode.NewFields;
                                let currency = newFields.Balance.currency;
                                let humanReadableCurr = normalizeCurrencyCodeXummImpl(currency);

                                let destination = newFields.HighLimit.issuer != wallet.classicAddress ? newFields.HighLimit.issuer : newFields.LowLimit.issuer;

                                if(latestLiveRates.has(currency)) {
                                    let rate = latestLiveRates.get(currency);

                                    if(rate) {
                                        let tlValue = newFields.HighLimit.issuer != wallet.classicAddress ? newFields.HighLimit.value : newFields.LowLimit.value;
                                        let numberedTlValue = Number(tlValue);

                                        await sendTokens(destination, currency, rate, numberedTlValue);
                                    }
                                } else {
                                    //try to fetch rate
                                    supportedApiCurrencies.push(currency);
                                    fs.writeFileSync("../apiCurrencies", JSON.stringify({supported: supportedApiCurrencies}));

                                    await watchLiveRates();
                                    await checkOffers();

                                    if(latestLiveRates.has(currency)) {
                                        let rate = latestLiveRates.get(currency);
    
                                        if(rate) {
                                            let tlValue = newFields.HighLimit.issuer != wallet.classicAddress ? newFields.HighLimit.value : newFields.LowLimit.value;
                                            let numberedTlValue = Number(tlValue);
    
                                            await sendTokens(destination, currency, rate, numberedTlValue);
                                        }

                                    } else {
                                        //seems like this is not supported!
                                        const currCode = currency != humanReadableCurr ? ( '"' + humanReadableCurr + '"' + " ( " + currency + " )") : ( '"' + currency + '"');
                                        const memoType = "Liquidity-Bot-Info";
                                        const memoText = "The currency code " + currCode + " is not supported yet.";

                                        let not_supported_message:Payment = {
                                            TransactionType: "Payment",
                                            Account: wallet.classicAddress,
                                            Amount: "1",
                                            Destination: destination,
                                            Memos: [{Memo: {MemoType: Buffer.from(memoType, 'utf8').toString('hex').toUpperCase(), MemoData: Buffer.from(memoText, 'utf8').toString('hex').toUpperCase()}}]
                                        }

                                        if(networkId) {
                                            not_supported_message.NetworkID = networkId;
                                        }
                            
                                        if(sendTokensClient && !sendTokensClient.isConnected()) {
                                            await sendTokensClient.connect();
                                        }
                            
                                        let submitResponse = await sendTokensClient.submit(not_supported_message, {wallet: wallet, autofill: true})
                            
                                        if(!submitResponse || !submitResponse.result || submitResponse.result.engine_result != 'tesSUCCESS') {
                                            //try again!
                                            if(sendTokensClient && !sendTokensClient.isConnected()) {
                                                await sendTokensClient.connect();
                                            }
                                            submitResponse = await sendTokensClient.submit(not_supported_message, {wallet: wallet, autofill: true})
                            
                                            if(!submitResponse || !submitResponse.result || submitResponse.result.engine_result != 'tesSUCCESS') {
                                                console.log(JSON.stringify(submitResponse));
                                                console.log(not_supported_message);
                                            }
                                        }
                            
                                        await sendTokensClient.disconnect();
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    } catch(err) {
        console.log("ERR analyzing incoming trustline");
        console.log(err);
        console.log(JSON.stringify(err));
    }
}

async function sendTokens(destination:string, currency:string, rate:number, tlValue:number) {

    try {

        console.log("tlValue: " + tlValue);
        console.log("rate: " + rate);

        let valueToSend = sellWallAmountInXrp*0.1*rate;

        console.log("valueToSend: " + valueToSend);

        if(tlValue <= 0) {
            valueToSend = 0;
        } else if(tlValue/2 < valueToSend) {
            valueToSend = tlValue/2
        }

        if(valueToSend > 0) {

            let normalizedValue = normalizeBalance(valueToSend);

            console.log("SEND: " + normalizedValue + " " + currency);

            let paymentTrx:Payment = {
                TransactionType: "Payment",
                Account: wallet.classicAddress,
                Destination: destination,
                Amount: {
                    currency: currency,
                    issuer: wallet.classicAddress,
                    value: normalizedValue
                }
            }

            if(networkId) {
                paymentTrx.NetworkID = networkId;
            }

            if(sendTokensClient && !sendTokensClient.isConnected()) {
                await sendTokensClient.connect();
            }

            let submitResponse = await sendTokensClient.submit(paymentTrx, {wallet: wallet, autofill: true})

            if(!submitResponse || !submitResponse.result || submitResponse.result.engine_result != 'tesSUCCESS') {
                //try again!
                if(sendTokensClient && !sendTokensClient.isConnected()) {
                    await sendTokensClient.connect();
                }
                submitResponse = await sendTokensClient.submit(paymentTrx, {wallet: wallet, autofill: true})

                if(!submitResponse || !submitResponse.result || submitResponse.result.engine_result != 'tesSUCCESS') {
                    console.log(JSON.stringify(submitResponse));
                    console.log(paymentTrx);
                }
            }

            await sendTokensClient.disconnect();
        }
    } catch(err) {
        console.log("ERR SENDING TOKENS");
        console.log(err);
        console.log(JSON.stringify(err));
    }

    //console.log("BUY:")
    //console.log(submitResponse);
}

function normalizeBalance(balance:number): string {
    let stringNumber = balance.toString();
    let splitNumber = stringNumber.includes('.') ? stringNumber.split(".") : null;

    let returnNumber = null;

    if(splitNumber) {
        returnNumber = balance.toFixed(15-splitNumber[0].length);

    } else {
        returnNumber = balance.toString();
    }

    return Number(returnNumber).toString();
    
}

function sleep(ms:number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function normalizeCurrencyCodeXummImpl(currencyCode: string, maxLength = 20): string {
    if (!currencyCode) return '';

    // Native XRP
    if (currencyCode === 'XRP') {
        return currencyCode;
    }

    // IOU claims as XRP which consider as fake XRP
    if (currencyCode.toLowerCase() === 'xrp') {
        return 'FakeXRP';
    }

    // IOU
    // currency code is hex try to decode it
    if (currencyCode.match(/^[A-F0-9]{40}$/)) {
        let decoded:string|undefined = '';

        // check for XLS15d
        if (currencyCode.startsWith('02')) {
            try {
                const binary = HexEncoding.toBinary(currencyCode);
                if(binary)
                    decoded = binary.slice(8).toString('utf-8');
            } catch {
                decoded = HexEncoding.toString(currencyCode);
            }
        } else {
            decoded = HexEncoding.toString(currencyCode);
        }

        if (decoded) {
            // cleanup break lines and null bytes
            const clean = decoded.replace(/\0/g, '').replace(/(\r\n|\n|\r)/gm, ' ');

            // check if decoded contains xrp
            if (clean.toLowerCase().trim() === 'xrp') {
                return 'FakeXRP';
            }
            currencyCode = clean;

            if(currencyCode === "USDT" || currencyCode === "USDC" || currencyCode === "DAI") {
                currencyCode = "USD";
            }

            if(currencyCode === "EURT" || currencyCode === "EURt" || currencyCode === "EURC" || currencyCode === "EURS") {
                currencyCode = "EUR";
            }
        }

        // if not decoded then return hex value
        return currencyCode;
    }

    return currencyCode;
};

/* Hex Encoding  ==================================================================== */
const HexEncoding = {
    toBinary: (hex: string): Buffer | undefined => {
        return hex ? Buffer.from(hex, 'hex') : undefined;
    },

    toString: (hex: string): string | undefined => {
        return hex ? Buffer.from(hex, 'hex').toString('utf8') : undefined;
    },

    toHex: (text: string): string | undefined => {
        return text ? Buffer.from(text).toString('hex') : undefined;
    },

    toUTF8: (hex: string): string | undefined => {
        if (!hex) return undefined;

        const buffer = Buffer.from(hex, 'hex');
        const isValid = Buffer.compare(Buffer.from(buffer.toString(), 'utf8'), buffer) === 0;

        if (isValid) {
            return buffer.toString('utf8');
        }
        return hex;
    },
};

start();