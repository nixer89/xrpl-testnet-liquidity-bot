import { Client, AccountLinesRequest, AccountOffersRequest, OfferCreate, Wallet, OfferCancel, OfferCreateFlags, AccountOffer, dropsToXrp, xrpToDrops, Payment, SubscribeRequest, TransactionStream } from 'xrpl';
import { XrplClient } from 'xrpl-client';
import { scheduleJob } from 'node-schedule';
import { Trustline } from 'xrpl/dist/npm/models/methods/accountLines';
import * as fetch from 'node-fetch';
import { isCreatedNode } from 'xrpl/dist/npm/models/transactions/metadata';

let livenetClient = new XrplClient();
let testnetClient = new XrplClient(['ws://127.0.0.1:6006','wss://testnet.xrpl-labs.com/', 'wss://s.altnet.rippletest.net:51233']);
let seed:string = process.env.ACCOUNT_SEED || '';
let wallet = Wallet.fromSeed(seed);
let latestLiveRates:Map<string, number> = new Map();
let submitClient = new Client('ws://127.0.0.1:6006');
let sendTokensClient = new Client('ws://127.0.0.1:6006');
let sellWallAmountInXrp:number = 100000;

require("log-timestamp");

async function start() {
    console.log("wallet: " , wallet);

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

                let trustlines:Trustline[] = accountLinesResponse.lines;
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

                //console.log(currentPrice);

                if(currentPrice['bnb']) {
                    //console.log("adding rate: " + "BNB" + " | " + currentPrice['bnb']);
                    latestLiveRates.set('BNB', currentPrice['bnb']);
                }

                if(currentPrice['btc']) {
                    //console.log("adding rate: " + "BTC" + " | " + currentPrice['btc']);
                    latestLiveRates.set('BTC', currentPrice['btc']);
                }

                if(currentPrice['cny']) {
                    //console.log("adding rate: " + "CNY" + " | " + currentPrice['cny']);
                    latestLiveRates.set('CNY', currentPrice['cny']);
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

    if(oldOfferSequence && oldOfferSequence > 0) {
        newOffer.OfferSequence = oldOfferSequence;
    }

    let submitResponse = await submitClient.submit(newOffer, {wallet: wallet, autofill: true})

    if(!submitResponse || !submitResponse.result || submitResponse.result.engine_result != 'tesSUCCESS') {
        //try again!
        submitResponse = await submitClient.submit(newOffer, {wallet: wallet, autofill: true})
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

    if(oldOfferSequence && oldOfferSequence > 0) {
        newOffer.OfferSequence = oldOfferSequence;
    }

    let submitResponse = await submitClient.submit(newOffer, {wallet: wallet, autofill: true})

    if(!submitResponse || !submitResponse.result || submitResponse.result.engine_result != 'tesSUCCESS') {
        //try again!
        submitResponse = await submitClient.submit(newOffer, {wallet: wallet, autofill: true})
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

    let cancelOfferSubmit = await submitClient.submit(offerCancel, {wallet: wallet, autofill: true});

    if(!cancelOfferSubmit || !cancelOfferSubmit.result || cancelOfferSubmit.result.engine_result != 'tesSUCCESS') {
        //try again!
        await submitClient.submit(offerCancel, {wallet: wallet, autofill: true})
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

                                if(latestLiveRates.has(currency)) {
                                    let rate = latestLiveRates.get(currency);

                                    if(rate) {
                                        let destination = newFields.HighLimit.issuer != wallet.classicAddress ? newFields.HighLimit.issuer : newFields.LowLimit.issuer;
                                        let tlValue = newFields.HighLimit.issuer != wallet.classicAddress ? newFields.HighLimit.value : newFields.LowLimit.value;
                                        let numberedTlValue = Number(tlValue);

                                        await sendTokens(destination, currency, rate, numberedTlValue);
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

        let valueToSend = sellWallAmountInXrp*0.01*rate;

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

            if(sendTokensClient && !sendTokensClient.isConnected()) {
                await sendTokensClient.connect();
            }

            let submitResponse = await sendTokensClient.submit(paymentTrx, {wallet: wallet, autofill: true})

            if(!submitResponse || !submitResponse.result || submitResponse.result.engine_result != 'tesSUCCESS') {
                //try again!
                submitResponse = await sendTokensClient.submit(paymentTrx, {wallet: wallet, autofill: true})
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

start();