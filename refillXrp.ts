import { Client, Wallet, AccountInfoRequest, dropsToXrp } from 'xrpl';
import { scheduleJob } from 'node-schedule';
import * as fetch from 'node-fetch';

let seed:string = process.env.ACCOUNT_SEED || '';
let wallet = Wallet.fromSeed(seed);
let xrplClient = new Client('wss://testnet.xrpl-labs.com')

require("log-timestamp");

async function start() {
    console.log("wallet: " , wallet);

    try {
        xrplClient.connect();
    } catch(err) {
        console.log(err);
    }

    scheduleJob('xrplLiveRateOracle', { second: 0 } , () => refillXrp());
    scheduleJob('xrplLiveRateOracle', { second: 10 } , () => refillXrp());
    scheduleJob('xrplLiveRateOracle', { second: 20 } , () => refillXrp());
    scheduleJob('xrplLiveRateOracle', { second: 30 } , () => refillXrp());
    scheduleJob('xrplLiveRateOracle', { second: 40 } , () => refillXrp());
    scheduleJob('xrplLiveRateOracle', { second: 50 } , () => refillXrp());

    console.log("refiller started!")
}

async function refillXrp() {
    try {

        if(!xrplClient.isConnected()) {
            try {
                await xrplClient.connect();
            } catch(err) {
                //trigger restart!
                process.exit(0);
            }
        }

        let accInfoRequest:AccountInfoRequest = {
            command: "account_info",
            account: wallet.classicAddress
        }

        let accInfoResponse = await xrplClient.request(accInfoRequest);

        if(accInfoResponse && accInfoResponse.result) {
            let info = accInfoResponse.result;

            if(info && info.account_data && info.account_data.Balance) {
                let xrpBalance = Number(dropsToXrp(info.account_data.Balance));

                if(xrpBalance < 1000000) {
                    console.log("Low account balance. Refilling!")
                    let response = await fetch.default("https://faucet.altnet.rippletest.net/accounts", {method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({"destination": wallet.classicAddress})});

                    if(response && response.ok) {
                        let jsonResponse = await response.json();
                        console.log(jsonResponse);
                    } else {
                        console.log(response.status);
                        console.log(response.statusText);
                    }
                }
            }
        }

    } catch(err) {
        console.log(err);
        console.log(JSON.stringify(err));
    }
}

start();