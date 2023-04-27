import { Client, AccountLinesRequest, AccountOffersRequest, OfferCreate, Wallet, OfferCancel, OfferCreateFlags, AccountOffer, qualityToDecimal, dropsToXrp, xrpToDrops } from 'xrpl';
import { XrplClient } from 'xrpl-client';
import { scheduleJob } from 'node-schedule';
import { Trustline } from 'xrpl/dist/npm/models/methods/accountLines';
import * as fetch from 'node-fetch';

let livenetClient = new XrplClient();
let testnetClient = new XrplClient(['wss://testnet.xrpl-labs.com/', 'wss://s.altnet.rippletest.net:51233/']);
let seed:string = process.env.ACCOUNT_SEED || '';
let wallet = Wallet.fromSeed(seed);
let latestLiveRates:Map<string, number> = new Map();
let submitClient = new Client('wss://s.altnet.rippletest.net')
let sellWallAmountInXrp:number = 100000;

require("log-timestamp");

async function start() {
    console.log("wallet: " , wallet);

    await watchLiveRates();
    await checkOffers();
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
                        let oldOffersToDelete:number[] = [];

                        for(let i = 0; i < offers.length;i++) {
                            let singleOffer = offers[i];
                            if(typeof singleOffer.taker_gets === 'object' && typeof singleOffer.taker_pays === 'string') {

                                let offerXrpAmount = Number(dropsToXrp(singleOffer.taker_pays));

                                if(currencyKey === singleOffer.taker_gets.currency) {
                                    let offerRate = Number((Number(singleOffer.quality)/1000000).toFixed(12));
                                    let convertedLiveRate = 1/liveRate;

                                    //console.log("currency: " + currencyKey);
                                    //console.log("offer rate: " + offerRate);
                                    //console.log("convertedLiveRate: " + convertedLiveRate);

                                    let diff = Math.abs((offerRate * 100 / convertedLiveRate) - 100)

                                    //console.log("diff: " + diff);

                                    oldOffersToDelete.push(singleOffer.seq);

                                    if('MYR' === currencyKey) {
                                        if(diff <= 10) {
                                            createNewOffers = false;    
                                        }
                                    } else {
                                        if(diff <=2) {
                                            //console.log("diff: " + diff);
                                            createNewOffers = false;
                                        }
                                    }

                                    if(offerXrpAmount < (sellWallAmountInXrp/2)) {
                                        console.log(currencyKey+": SELL offerXrpAmount: " + offerXrpAmount);
                                        lowXrpOfferAmount = true;
                                    }

                                }
                            }

                            if(typeof singleOffer.taker_pays === 'object' && typeof singleOffer.taker_gets === 'string') {

                                let offerXrpAmount = Number(dropsToXrp(singleOffer.taker_gets));

                                if(currencyKey === singleOffer.taker_pays.currency) {
                                    oldOffersToDelete.push(singleOffer.seq);

                                    if(offerXrpAmount < (sellWallAmountInXrp/2)) {
                                        console.log(currencyKey+": BUY offerXrpAmount: " + offerXrpAmount);
                                        lowXrpOfferAmount = true;
                                    }
                                }
                            }
                        }

                        if(createNewOffers || oldOffersToDelete.length > 2 || lowXrpOfferAmount) { //no sell offer found. create it!
                            console.log("CREATING NEW OFFERS FOR " + currencyKey);
                            await sleep(500);
                            await createSellOffer(currencyKey, liveRate*0.995)
                            await sleep(500);
                            await createBuyOffer(currencyKey, liveRate*1.005)

                            if(oldOffersToDelete && oldOffersToDelete.length > 0) {
                                console.log("DELETING OLD OFFERS");
                                await sleep(500);
                                for(let j = 0; j < oldOffersToDelete.length; j++) {
                                    await cancelOldOffer(oldOffersToDelete[j]);
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

async function createSellOffer(currency:string, rate:number) {

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

    let submitResponse = await submitClient.submit(newOffer, {wallet: wallet, autofill: true})

    if(!submitResponse || !submitResponse.result || submitResponse.result.engine_result != 'tesSUCCESS') {
        //try again!
        submitResponse = await submitClient.submit(newOffer, {wallet: wallet, autofill: true})
    }

    //console.log("SELL:")
    //console.log(submitResponse);
}

async function createBuyOffer(currency:string, rate:number) {

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