import { Client, Wallet, AccountSet, AccountSetAsfFlags } from 'xrpl';
import 'log-timestamp';

let seed:string = process.env.ACCOUNT_SEED || '';
let wallet = Wallet.fromSeed(seed);
let xrplClient = new Client(process.env.XRPL_SERVER || 'ws://127.0.0.1:6006')
let networkId = process.env.NETWORK_ID ? Number(process.env.NETWORK_ID) : null;

async function start() {
    try {
        if(!xrplClient.isConnected()) {
            try {
                await xrplClient.connect();
            } catch(err) {
                //trigger restart!
                process.exit(0);
            }
        }

        let setDefaultRipple:AccountSet = {
            TransactionType: "AccountSet",
            Account: wallet.classicAddress,
            SetFlag: AccountSetAsfFlags.asfDefaultRipple
        }

        if(networkId) {
            setDefaultRipple.NetworkID = networkId;
        }

        let submitResponse = await xrplClient.submit(setDefaultRipple, {wallet: wallet, autofill: true})

        if(!submitResponse || !submitResponse.result || submitResponse.result.engine_result != 'tesSUCCESS') {
            //try again!
            submitResponse = await xrplClient.submit(setDefaultRipple, {wallet: wallet, autofill: true})
        }

        console.log(submitResponse);

        process.exit(0);

    } catch(err) {
        console.log(err);
    }
}

start();