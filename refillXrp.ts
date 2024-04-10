import { Client, Wallet, AccountInfoRequest, dropsToXrp } from 'xrpl';
import { scheduleJob } from 'node-schedule';
import * as fetch from 'node-fetch';
import 'log-timestamp';

let seed:string = process.env.ACCOUNT_SEED || '';
let wallet = Wallet.fromSeed(seed);
let xrplClient = new Client(process.env.XRPL_SERVER || 'ws://127.0.0.1:6006')
let faucetURL = process.env.FAUCET_URL || "https://faucet.altnet.rippletest.net/accounts";

async function start() {
    console.log("wallet: " , wallet);

    try {
        xrplClient.connect();
    } catch(err) {
        console.log(err);
    }

    scheduleJob('refillXrp1', { second: 0 } , () => refillXrp());
    scheduleJob('refillXrp2', { second: 10 } , () => refillXrp());
    scheduleJob('refillXrp3', { second: 20 } , () => refillXrp());
    scheduleJob('refillXrp4', { second: 30 } , () => refillXrp());
    scheduleJob('refillXrp5', { second: 40 } , () => refillXrp());
    scheduleJob('refillXrp6', { second: 50 } , () => refillXrp());

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

                let balance:number = Number(info.account_data.Balance);
                balance = balance - 10000000; //deduct acc reserve
                balance = balance - (info.account_data.OwnerCount * 2000000); //deduct owner count

                let xrpBalance = Number(dropsToXrp(balance));

                if(xrpBalance < 1000000) {
                    console.log("Low account balance. Refilling!")
                    let response = await fetch.default(faucetURL, {method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({"destination": wallet.classicAddress})});

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

        try {
            console.log("Account not found. create it!")
            //account probably not found. create it!
            let response = await fetch.default(faucetURL, {method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({"destination": wallet.classicAddress})});

            if(response && response.ok) {
                let jsonResponse = await response.json();
                console.log(jsonResponse);
            } else {
                console.log(response.status);
                console.log(response.statusText);
            }
        } catch(err) {
            console.log(err);
        }
    }
}

start();