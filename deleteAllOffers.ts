import { Client, AccountOffersRequest, Wallet, OfferCancel, AccountOffer } from 'xrpl';
import 'log-timestamp';

let seed:string = process.env.ACCOUNT_SEED || '';
let wallet = Wallet.fromSeed(seed);
let submitClient = new Client(process.env.XRPL_SERVER || 'ws://127.0.0.1:6006')
let networkId = process.env.NETWORK_ID ? Number(process.env.NETWORK_ID) : null;

async function start() {
    console.log("deleting all offers...");

    await deleteOffers();

    console.log("DONE!");

    process.exit(0);
}


async function deleteOffers() {
    let accountOfferRequest:AccountOffersRequest = {
        command: 'account_offers',
        account: wallet.classicAddress,
        limit: 400
    }

    if(submitClient && !submitClient.isConnected()) {
        await submitClient.connect();
    }

    let accountOffersResponse = await submitClient.request(accountOfferRequest);

    if(accountOffersResponse) {

        if(accountOffersResponse?.result?.offers) {
            let offers:AccountOffer[] = accountOffersResponse.result.offers;

            if(submitClient && !submitClient.isConnected()) {
                await submitClient.connect();
            }

            for(let i = 0; i < offers.length;i++) {
                let singleOffer = offers[i];
                sleep(500);
                await cancelOldOffer(singleOffer.seq);
            }

            await submitClient.disconnect();
        }
    }
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
        await submitClient.submit(offerCancel, {wallet: wallet, autofill: true})
    }
}

function sleep(ms:number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

start();