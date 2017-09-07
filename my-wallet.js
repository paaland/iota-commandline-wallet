/*
 *
 *          IOTA Command Line Wallet
 *
 * (c) by Michael Schwab <michael.schwab@mikeshouse.de>
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 675 Mass Ave, Cambridge, MA 02139, USA.
 *
 * For more information on the GPL, please go to:
 * http://www.gnu.org/copyleft/gpl.html
*/

/*
    External Components required:

    Persistent datastore with automatic loading by Louis Chatriot
    https://github.com/louischatriot/nedb

    IOTA Javascript Library by Dominik Schiener
    https://github.com/iotaledger/iota.lib.js
*/

// Address status
// 1. new = unused not attached to tangle
// 2. attached = has one or more transactions with value 0
// 3. used = has transactions but no outgoing transactions and balance > 0
// 4. exhausted = has one confirmed outgoing transaction, no more transactions should issued with this address
// 5. overused = has more than one outgoing transaction, this should not happen, but can be forced by the user

main();

async function main()
{
    var config;
    var version = "Version 0.5 Beta";
    try
    {
        config = require('./iota-wallet-config');
    }
    catch(e)
    {
        error_output("iota-wallet-config.js configuration file not found or invalid format");
        return;
    }

    try
    {
        var path = require('path');
        var crypto = require('crypto');
        var Datastore = require('nedb');
        var IOTA = require('iota.lib.js');
    }
    catch(e)
    {
        error_output("required modules missing, read documentation for help, modules are path crypto nedb iota.lib.js");
        return;
    }

    // Get filename in order to find the right config section in iota-wallet-config.js
    var filename = path.basename(process.argv[1]);
    filename = filename.substr(0,filename.length-3);
    if (config[filename] == undefined)
    {
        error_output("no config section named  "+filename+"  in file iota-wallet-config.js found, please add one");
        return;
    }

    debug_output("Using config: "+filename,9);

    var db;
    try { db = new Datastore({ filename: config[filename].databaseFile, autoload: true }); }
    catch(e)
    {
        error_output("Database initialisation failed. "+e.message);
        return;
    }

    var seed = config[filename].seed;
    if ( seed == "")
    { error_output("No seed provided, please enter your seed into the configuration file"); return;}

    // Create IOTA instance directly with provider
    var iota = new IOTA({
        'provider': config.provider
    });

    var cmd_result = ""; // this is the string containing all the resultdata of the command.
    var command = process.argv[2]; // Command telling what should be done

    if (command == "" || command == undefined)
    {
        showhelp(version);
        return;
    }

    if (command == "help" || command == "Help")
    {
        showcommands(version);
        return;
    }


    // This syncs the tangle status to the local database, sync uses only addresses which might have gotten additional transactions
    // syncall syncs all addresses in the database even they should not be used for new transactions anymore
    // and rebuilds the entire database.
    // You could delete the database and rebuild it with SyncAll when you have no pending transactions.
    if (command == "Sync" || command == "SyncAll" || command == "S" || command == "SA")
    {
        var end;
        var sync_all_flag = 0;

        if (command == "SyncAll" || command == "SA")
        { sync_all_flag = 1; }

        if ( process.argv[3] != undefined)
        {
            end = process.argv[3];
            debug_output("Scanning till address: "+end,3);
        }
        else
        {
            end = -1;
        }
        await update_address_database(db, iota, seed, 0, end, sync_all_flag);
    }


    // Show Database only show non new addresses in order to avoid to copy paste
    // them and mess up the DB hosekeeping, always use GetNewAddress to get a new address
    if (command == "SDB" || command == "ShowDB" || command == "ShowEntireDB")
    {
        var flag = 0;
        if ( command == "ShowEntireDB" ) { flag = 1; }
        var i;
        var query = { };
        var rows = await dbFind(db,query,{index: 1});
        if ( rows.length == 0)
        {
            return;
        }

        for(i = 0; i<rows.length; i++)
        {
            if ( rows[i].status != "new" || flag == 1)
            {
                if ( process.stdout.columns >= 140)
                {
                    debug_output("INDEX: "+rows[i].index+" ADR: "+rows[i].address+" Balance: "+rows[i].balance+" Status: "+rows[i].status,0);
                }
                else
                {
                    debug_output("Address: "+rows[i].address,0);
                    debug_output("INDEX: "+rows[i].index+" Balance: "+rows[i].balance+" Status: "+rows[i].status,0);
                    debug_output("",0);
                }
            }
        }
    }

    // Display a compeltely unused address
    if (command == "GNA" || command == "GetNewAddress")
    {
        cmd_result = await get_new_address(db,iota,seed);
        json_output(cmd_result);
    }

    // Get the status of a transaction
    if (command == "GetConfirmationState" || command == "GCS" )
    {
        var bundle_hash = process.argv[3];
        if (bundle_hash == undefined || iota.valid.isHash(bundle_hash) == false)
        {
            error_output("please provide a vaild bundle hash");
            return;
        }

        var result = await getBundleConfirmationState(iota, bundle_hash);
        json_output(result);
    }

    // Send IOTA to an Address
    if (command == "send" || command == "Send" || command == "transfer" || command == "Transfer")
    {
        var address = process.argv[3];
        if (address == undefined || iota.valid.isAddress(address) == false)
        {
            error_output("please provide a vaild address to send your transfer to");
            return;
        }

        var amount = process.argv[4];
        if (amount == undefined || amount < 0)
        {
            error_output("please provide a vaild amount to transfer");
            return;
        }
        try
        {
            var json_result = {};
            var transfer_result = await execute_transfer(db, iota, seed, address, amount, "", "");

            for(var i=0; i < transfer_result.length; i++)
            {
                if (transfer_result[i].currentIndex == 0)
                {
                    debug_output("BUNDLE: "+transfer_result[i].bundle,3);
                    debug_output("TRANSACTION: "+transfer_result[i].hash,3);
                    json_result = {bundle: transfer_result[i].bundle, tailTransaction: transfer_result[i].hash};
                }
            }
            json_output(json_result);
            //console.log(" ");
            //json_output(transfer_result);
        }
        catch(e)
        {
            console.log("ERROR: "+e.message);
            return;
        }
    }

    // Get all balances from server and update database
    if (command == "UpdateBalances" || command == "UBS")
    {
        await updateBalances(db, iota);
    }

    if (command == "ShowBalance" || command == "SB")
    {
        var query = {};
        var rows = await dbFind(db,query,{index: 1});
        var i;
        var balance = 0;

        if (rows.length == 0)
        {
            error_output("No addresses in database");
            return;
        }

        for(i=0; i < rows.length; i++)
        {
            balance += parseInt(rows[i].balance);
        }
        json_output({ totalBalance: balance, unit: "iota"});
        //debug_output("Balance: "+balance+" iota",1);
    }

    if (command == "Replay" || command == "R")
    {
        var address = process.argv[3];
        if (address == undefined || iota.valid.isAddress(address) == false)
        {
            error_output("please provide a vaild address to scan for replay suggestions");
            return;
        }

        // 1. Get all transactions for this address
        var transactions = await findTransactions(iota, { addresses: [address] });

        var bundles = {};

        for (var i = 0; i < transactions.length; i++)
        {
            debug_output("-------------------- TRANSACTION:"+i,9);
            debug_output("HASH:     "+transactions[i].hash,9);
            debug_output("BUNDLE    "+transactions[i].bundle,9);
            debug_output("VALUE     "+transactions[i].value,9);
            debug_output("INDEX     "+transactions[i].currentIndex,9);

            // 2. Get all bundles
            // Get the bundles to which the transaction belongs to see all transactions in the bundle
            // check their inclusion states and find the tailTransaction for a possible replay
            var transactions_in_bundle = await findTransactions(iota, { bundles: [transactions[i].bundle] });

            // initialize new bundle object with defaults
            if (bundles[transactions[i].bundle] == undefined)
            {
                bundles[transactions[i].bundle] = {};
                bundles[transactions[i].bundle].confirmedTransactions = 0;
                bundles[transactions[i].bundle].unconfirmedTransactions = 0;
                bundles[transactions[i].bundle].tailTransaction = "";
                bundles[transactions[i].bundle].count = 1;
                bundles[transactions[i].bundle].validFunding = true;
                bundles[transactions[i].bundle].fundingAddresses = [];
            }
            else
            {
                // How many bundles with the same hash were found? if(>1) These are possibly replays
                bundles[transactions[i].bundle].count++;
            }

            // 3. Find hashes of bundles which contain unconfirmed transactions
            for (var j = 0; j < transactions_in_bundle.length; j++)
            {
                //debug_output("+++++++++++++++++ BUNDLE TRANSACTION :"+j);
                //debug_output(JSON.stringify(transactions_in_bundle[j]));

                var inclusionstates = await getLatestInclusion(iota, [transactions_in_bundle[j].hash] );
                var inclusion = inclusionstates[0];
                //debug_output("INCLUSION "+inclusion);

                // Find the tail transaction where currentIndex == 0 in the bundle
                // this transaction hash is required later to replay the bundle
                if (transactions_in_bundle[j].currentIndex == 0)
                { bundles[transactions[i].bundle].tailTransaction = transactions_in_bundle[j].hash; }

                if ( inclusion == true )
                { bundles[transactions[i].bundle].confirmedTransactions++; }

                if ( inclusion == false )
                { bundles[transactions[i].bundle].unconfirmedTransactions++; }

                // 4. Chek for balances on funding the bundles if they are still valid do a replay
                // found a funding transaction
                if ( transactions_in_bundle[j].value < 0 )
                {
                    // get the balance
                    var balances = await getBalance(iota, [transactions_in_bundle[j].address]);
                    var balance = balances.balances[0];
                    var needed_balance = transactions_in_bundle[j].value * -1;
                    bundles[transactions[i].bundle].fundingAddresses.push(transactions_in_bundle[j].address);
                    if (balance !=  needed_balance)
                    {
                        //debug_output("Insufficent balance! Need: "+needed_balance+" current balance is: "+balance)
                        bundles[transactions[i].bundle].validFunding = false;
                    }
                    else
                    {
                        //debug_output("Balance is ok");
                    }
                }
                //debug_output(" ");
            }
        }

        debug_output(" ");
        // Check all bundles finding confirmation state and alredy done replays
        for (bundle in bundles)
        {
            debug_output("BUNDLE: "+bundle,9);
            debug_output("COUNT: "+bundles[bundle].count+" CONFIRMED Tx IN BUNDLE: "+bundles[bundle].confirmedTransactions+" UNCONFIRMED Tx: "+bundles[bundle].unconfirmedTransactions+" TAIL: "+bundles[bundle].tailTransaction+" Funding: "+bundles[bundle].validFunding,9);
            debug_output("FUNDING ADDRESS: "+bundles[bundle].fundingAddresses,9);
            debug_output(" ",9);
        }

        var json_result = [];
        for (bundle in bundles)
        {
            if (bundles[bundle].validFunding == true && bundles[bundle].confirmedTransactions == 0)
            {
                debug_output("Replaying",3);
                debug_output("COUNT: "+bundles[bundle].count+" CONFIRMED Tx IN BUNDLE: "+bundles[bundle].confirmedTransactions+" UNCONFIRMED Tx: "+bundles[bundle].unconfirmedTransactions+" TAIL: "+bundles[bundle].tailTransaction+" Funding: "+bundles[bundle].validFunding,3);

                var result = await replayBundle(iota, bundles[bundle].tailTransaction, 5, 15); // 5 = tip selection depth , 15 = minWeightMagnitude
                json_result.push(result[0].bundle);
            }
        }

        json_result = { replayedBundles: json_result};
        json_output(json_result);

    }

    // Get all balances from server and update database
    if (command == "GetBundles" || command == "GBS")
    {
        var address = process.argv[3];
        if (address == undefined || iota.valid.isAddress(address) == false)
        {
            error_output("please provide a vaild address to to get the bundles for");
            return;
        }

        var bundles = await getBundles(db, iota, address);
        json_output(bundles);
    }

} // end main function

/* Subroutines
 *
 *
 */

/*---------------------------------------------------------------------------------------------------*/

function showhelp(version)
{
    debug_output("Welcome to Mikes IOTA commandline wallet "+version,0);
    debug_output("I highly appreciate that you want to use IOTA.",0);
    debug_output("",0);
    debug_output("Please edit the configuration file named iota-wallet-config.js before you start",0);
    debug_output("",0);
    debug_output("For a complete help just type the word help behind the command",0);
    debug_output("example: node my-wallet.js help",0);
}

function showcommands(version)
{
    debug_output("Welcome to Mikes IOTA commandline wallet "+version,0);
    debug_output("List of Commands",0);
    debug_output("Syntax: node my-wallet.js [command] <parameter1> <parameter2> <parameter...>",0);
    debug_output("Command               Parametrs           Purpose",0);
    debug_output("SyncAll               none                (re)Builds/creates the local Database",0);
    debug_output("Sync                  none                Updates the local Database only for addresses currently in use",0);
    debug_output("Transfer              Address Amount      Sends amount of iota to the given address",0);
    debug_output("GetNewAddress         none                Gives you a brand new address to send out for receiving funds",0);
    debug_output("GetBundles            Address             Gives you all bundles associated with the given address",0);
    debug_output("GetConfirmationState  Bundlehash          Gives you the confirmation state of a bundle",0);
    debug_output("UpdateBalances        none                Update all balances of all addresses in the database",0);
    debug_output("ShowBalance           none                Show the total balance of the wallet, be sure to UpdateBalances before",0);
    debug_output("Replay                Address             Replay all unconfirmed transactions associated with the given address",0);
    debug_output("ShowDB                none                Shows data from the local database",0);

    debug_output("",0);
    debug_output("Examples:",0);
    debug_output("node my-wallet.js Transfer DESTINATION9ADDRESS9SOME9MORE9TRYTES9OF9THE9DESTINATION9ADDRESS 10",0);
    debug_output("node my-wallet.js GetBundles DESTINATION9ADDRESS9SOME9MORE9TRYTES9OF9THE9DESTINATION9ADDRESS",0);
    debug_output("node my-wallet.js GetConfirmationState THE9BUNDLE9HASH9KJZTXIIHIHDXOFKJOIJIJOIJIMIM9NECWOI",0);
    debug_output("node my-wallet.js Replay DESTINATION9ADDRESS9SOME9MORE9TRYTES9OF9THE9DESTINATION9ADDRESS",0);
}


function debug_output(message,loglevel)
{
    if (loglevel <= 3)
    {
        console.log(message);
    }
}

function error_output(message,loglevel)
{
    console.log("ERROR: "+message);
    console.log("{ status: \"error\", message: \""+message+"\"}");
}

function json_output(json_data)
{
    if ( json_data.status == undefined )
    {
        json_data.status = "ok";
    }
    console.log(JSON.stringify(json_data));
}

async function getAddressFromIndex(db_handle, index)
{
        index = parseInt(index);

        var query = { index: index };
        var rows = await dbFind(db_handle,query,{index: 1});
        if ( rows.length == 1)
        {
            var address = rows[0].address;
            return address;
        }
        else
        {
            return "";
        }
}

async function getBundles(db, iota, address)
{
    var transactions = await findTransactions(iota, { addresses: [address] });

    var bundles = {};

    for (var i = 0; i < transactions.length; i++)
    {
        if ( bundles[transactions[i].bundle] == undefined)
        {
            //var confirmation_state = getBundleConfirmationState(iota, transactions[i].bundle)
            bundles[transactions[i].bundle] = { };
            bundles[transactions[i].bundle].replays = 0;
            bundles[transactions[i].bundle].hash = transactions[i].bundle;
        }
        else
        {
            bundles[transactions[i].bundle].replays++;
        }
        debug_output("-------------------- TRANSACTION:"+i,4);
        debug_output("HASH:     "+transactions[i].hash,4);
        debug_output("BUNDLE    "+transactions[i].bundle,4);
        debug_output("VALUE     "+transactions[i].value,4);
        debug_output("INDEX     "+transactions[i].currentIndex,4);
    }

    var return_value = [];
    for (var key in  bundles)
    {
        return_value.push({"bundle":key , "replays":bundles[key].replays});
    }
    return return_value;
}

async function updateBalances(db_handle, iota)
{
        var query = {};
        var rows = await dbFind(db_handle,query,{index: 1});
        var i;
        var address_array = [];
        var balances;

        if (rows.length == 0)
        {
            error_output("No addresses in database");
            return;
        }
        for(i=0; i < rows.length; i++)
        {
            address_array.push(rows[i].address);
            if (i % 20 == 0 || i == rows.length-1 )
            {
                balances = await getBalance(iota, address_array);
                for(var j=0; j < address_array.length; j++)
                {
                    var query = { address: address_array[j] };
                    var balance = parseInt(balances.balances[j]);
                    var update_result = await dbUpdate(db_handle,query,{ $set: {balance: balance }});
                    //console.log("Update result:"+JSON.stringify(update_result));
                }
                address_array = [];
                debug_output("Balances:"+JSON.stringify(balances),4);
            }
        }
}


async function execute_transfer(db_handle, iota, seed, dst_address, value, message, tag)
{
    if (message == undefined) {message = "";}
    if (tag == undefined) {tag = "";}
    var options = {};

    if (value > 0)
    {
        // find the funding addresses search the whole db for addresses with balance > 0 and sum them
        // up till there is enough balance for the transfer.
        var funding_array = [];
//        var query = { balance: { $gt: 0 } };
        var query = {};
        var rows = await dbFind(db_handle,query,{index: 1});

        debug_output("Searching for funding, found "+rows.length+" records in Database",9);

        if (rows.length == 0)
        {
            error_output("Your balance is zero!");
            return;
        }
        else
        {
            var total = 0;
            var i = 0;
            while (total < value && i < rows.length)
            {
                // sometimes the database contains invalid values needs to be fixed
                if (rows[i].address != undefined && iota.valid.isAddress(rows[i].address) && rows[i].balance > 0)
                {
                    var input = {};
                    debug_output("FUNDING ADR: "+rows[i].address+" BALANCE: "+rows[i].balance,4);
                    input.address = iota.utils.noChecksum(rows[i].address);
                    input.security = 2;
                    input.keyIndex = parseInt(rows[i].index);
                    funding_array.push(input);
                    total += parseInt(rows[i].balance);
                }
                i++;
            }
            if (total < value)
            {
                error_output("Your balance is insufficient! Found a total of "+total+" IOTA");
                return;
            }
        }
        if (total == value)
        {
            // We add a remainder address to the transfer, but this is not going to be used
            // since amount and balance matches, so this address should be kept in status new
            var remainder_adr = await get_new_address(db_handle,iota,seed,'new');
        }
        else
        {
            var remainder_adr = await get_new_address(db_handle,iota,seed);
        }

        remainder_adr = iota.utils.noChecksum(remainder_adr.address);
        options = { address: remainder_adr, inputs: funding_array };
        debug_output("OPTIONS: "+JSON.stringify(options),9);
    }
    value = parseInt(value);
    var transfers = [{ "address": dst_address, "value": value , message: message, tag: tag}];
    debug_output("TRANSFER OBJ: "+JSON.stringify(transfers),9);

    var result =  await doTransfer(iota, seed, transfers, options);
    return result;
}

function doTransfer(iota, from_seed,transfers,options)
{
    return new Promise( function(resolve, reject)
                        {
                            var depth = 5; // Depth for tip selection algo

                            // Some help needed here if i set minWeightMagnitude to 18 the PoW takes very long
                            // so i set it to 15 which sometimes triggers a Invalid transaction hash error
                            // question why is there an error ans what does minWeightMagnitude mean precisely
                            // the lower it is set the more errors occur ... strange
                            var minWeightMagnitude = 15; // PoW magnitude should be 18
                            iota.api.sendTransfer(from_seed, depth, minWeightMagnitude, transfers ,options,
                            function(error, success)
                            {
                                if (error) {  reject(error);  } else {  resolve(success);  }
                            } );
                        });
}

async function get_new_address(db_handle,iota,seed,status)
{
    var address = "";
    var query = { status: "new" };
    var rows = await dbFind(db_handle,query,{index: 1});
    if ( rows.length == 0)
    {
        // Create new addresses
        await addNewAddress(db_handle,iota,seed);
        rows = await dbFind(db_handle,query,{index: 1});
        if (rows.length == 0)
        {
            console.log("Could not get a new address something seems to be wrong with the database, possibly delete it and do a SyncAll to rebuild it");
            // ERROR there should be one address!!
        }
    }
    else
    {
        debug_output(rows[0].address+" INDEX: "+rows[0].index);
    }

    if (status == undefined)
    { status = "published"; }

    query = { index: rows[0].index };
    var update_result = await dbUpdate(db_handle,query,{ $set: {status: status }});

    return {address: rows[0].address , index: rows[0].index};
}

async function addNewAddress(db_handle,iota,seed,adr_index)
{
    var address = "";
    if (adr_index == undefined)
    {
        var rows = await dbFind(db_handle,{},{index: -1});
        if ( rows.length > 0)
        {
            adr_index = rows[0].index + 1;
        }
        else
        {
            adr_index = 0;
        }
        debug_output("NEXT INDEX:"+adr_index);
    }

    address = await getNewAddress(iota,seed,adr_index);
    address = address[0];

    debug_output("Adding address to db: "+address);

    var data = { index: adr_index, address: address, balance: 0, status: "new" };
    await dbInsert(db_handle,data);
    debug_output('successfully added');
    return address;
}

async function update_address_database(db_handle,iota,seed,start_adr_index,max_adr_index, update_all)
{
        var adr_index = start_adr_index;
        var new_address_count = 0;
        do
        {
            debug_output(adr_index+"---------------------------------------------------------------------------",9)
            var address;
            var inclusion ;
            var status;
            var balance_in_db;
            var query = { index: adr_index };
            var rows = await dbFind(db_handle,query);

            if ( rows.length == 0 )
            {
                address = await addNewAddress(db_handle,iota,seed,adr_index);
                status = "new";
                balance_in_db = 0;
            }
            else
            {
                debug_output("ROW: "+JSON.stringify(rows),9);
                debug_output("ADR: "+rows[0].address,9)
                address = rows[0].address;
                status = rows[0].status;
                balance_in_db = rows[0].balance;
            }

            if ( (status != "exhausted" && status != "overused") || update_all == 1  || balance_in_db > 0)
            {
                // Update address balance
                var balance = await getBalance(iota, [address]);
                debug_output("B: "+JSON.stringify(balance),9);
                var update_result = await dbUpdate(db_handle,query,{ $set: {balance: balance.balances[0] }});
                debug_output("DB Update completed",9);

                var transactions = await findTransactions(iota, { addresses: [address] });
                debug_output("TRANSACTIONS: "+JSON.stringify(transactions),9);
                var outgoing_transactions_count = 0;
                var zero_value_transactions_count = 0;
                var incoming_transactions_count = 0;
                for (j=0; j < transactions.length; j++)
                {
                    var inclusionstates = await getLatestInclusion(iota, [transactions[j].hash] );
                    inclusion = inclusionstates[0];
                    debug_output("Transcation: "+j+" Hash: "+transactions[j].hash+" value: "+transactions[j].value+" Inclusion: "+inclusion,4);
                    if (inclusion == true )
                    {
                        if (transactions[j].value < 0)
                        { outgoing_transactions_count++;}

                        if (transactions[j].value == 0)
                        { zero_value_transactions_count++;}

                        if ( transactions[j].value > 0)
                        { incoming_transactions_count++ }
                    }

                }
                // Address status
                // 1. new = unused not attached to tangle
                // 2. attached = has one or more transactions with value 0
                // 3. used = has transactions but no confirmed outgoing transactions and balance > 0
                // 4. exhausted = has one confirmed outgoing transaction, no more transactions should issued with this address
                // 5. overused = has more than one outgoing transaction, this should not happen but can be forced by the user
                if (outgoing_transactions_count == 1)
                { status = "exhausted" }
                else if (outgoing_transactions_count > 1)
                { status = "overused"}
                else if (outgoing_transactions_count == 0 && incoming_transactions_count > 0)
                { status = "used" }
                else if (outgoing_transactions_count == 0 && incoming_transactions_count == 0 && zero_value_transactions_count > 0)
                { status = "attached" }
                else if (outgoing_transactions_count == 0 && incoming_transactions_count == 0 && zero_value_transactions_count == 0 && (status == "" || status == undefined))
                { status = "new";}

                // count new addresses to always have some new addresses in your db
                if ( status == "new" ) {new_address_count++;}

                var update_result = await dbUpdate(db_handle,query,{ $set: {status: status }});

                debug_output("INDEX: "+adr_index+" ADR: "+address.substr(0,20)+".... Balance: "+balance.balances[0]+" Status: "+status,1);
            }

            adr_index++;

        } while ( (adr_index < max_adr_index && max_adr_index > 0) || (max_adr_index == 0 && inclusion == true) || (max_adr_index == -1 && new_address_count < 3) )
}

function getLatestInclusion (iotaHandle, transaction_hashes)
{
    return new Promise(
        function(resolve, reject)
        {
            iotaHandle.api.getLatestInclusion(transaction_hashes,
                    function(error, success)
                    {
                        if (error) { reject(error); } else { resolve(success); }
                    }
            );
        }
    );
}

async function getBundleConfirmationState(iota, bundle_hash)
{
    var transactions_in_bundle = await findTransactions(iota, { bundles: [bundle_hash] });
    var transaction = [];
    var true_count = 0
    var false_count = 0
    var status = "";
    var result;
    var value = 0;

    debug_output("T:"+JSON.stringify(transactions_in_bundle),9);

    for (var j = 0; j < transactions_in_bundle.length; j++)
    {
        transaction.push(transactions_in_bundle[j].hash);
        if (transactions_in_bundle[j].value > 0)
        { value += parseInt(transactions_in_bundle[j].value); }
    }

    var inclusionstates = await getLatestInclusion(iota, transaction );

    for (var j = 0; j < inclusionstates.length; j++)
    {
        if (inclusionstates[j] == true)
        { true_count++; }
        else if (inclusionstates[j] == false)
        { false_count++; }
    }

    if ( (true_count > 0 && value == 0) || (true_count > 2 && value > 0))
    { status = "confirmed"; } else { status = "unconfirmed"; }

    result = { confirmedTransactionsCount: true_count, unconfirmedTransactionsCount: false_count, status: status};
    return result;
}

function findTransactions(iotaHandle,searchValues)
{
    return new Promise(
        function(resolve, reject)
        {
            iotaHandle.api.findTransactionObjects(searchValues,
                    function(error, success)
                    {
                        if (error) { reject(error); } else { resolve(success); }
                    }
            );
        }
    );
}


function getNewAddress(iotaHandle,seed,index)
{
    return new Promise(
        function(resolve, reject)
        {
            iotaHandle.api.getNewAddress(seed , {"index": index, "checksum": true, "total": 1, "security": 2, "returnAll": false},
                function(error, success) {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(success);
                    }
                }
            );
        }
    );
}

function getBalance(iotaHandle, adr_array)
{
    return new Promise( function(resolve, reject)
    {
        iotaHandle.api.getBalances(adr_array, 100,
            function(error, balances_obj)
            {
                if (error) {  reject(error);  } else { resolve(balances_obj); }
            }
        );
    });
}

function dbInsert(dbHandle,data)
{
    return new Promise (
        function(resolve, reject)
        {
            dbHandle.insert(data,
                function (err, newDoc)
                {
                    if (err)
                    { reject(err); } else { resolve('Document inserted'); }
                }
            );
        }
    );
}

function dbUpdate(dbHandle,query,update)
{
    return new Promise (
        function(resolve, reject)
        {
            dbHandle.update(query, update, { multi: true},
                function (err, numReplaced)
                {
                    if (err)
                    { reject(err); } else { resolve(numReplaced); }
                }
            );
        }
    );
}

function dbFind(dbHandle,query,sort)
{
    if (sort == undefined)
    {
        return new Promise (
            function(resolve, reject)
            {
                dbHandle.find(query,
                    function (err, docs)
                    {
                        if (err) { reject(err); } else { resolve(docs); }
                    }
                );
            }
        );
    }
    else
    {
        return new Promise (
            function(resolve, reject)
            {
                dbHandle.find(query).sort(sort).exec(
                    function (err, docs)
                    {
                        if (err) { reject(err); } else { resolve(docs); }
                    }
                );
            }
        );
    }
}

function dbDelete(dbHandle,query)
{
    return new Promise (
        function(resolve, reject)
        {
            dbHandle.remove(query, { multi: true },
                function (err, numRemoved)
                {
                    if (err)
                    { reject(err); } else { resolve(numRemoved); }
                }
            );
        }
    );
}


function getNewAddress(iotaHandle,seed,index)
{
    return new Promise(
        function(resolve, reject)
        {
            iotaHandle.api.getNewAddress(seed , {"index": index, "checksum": true, "total": 1, "security": 2, "returnAll": true},
                function(error, success) {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(success);
                    }
                }
            );
        }
    );
}

function replayBundle(iotaHandle, tail, depth, minWeightMagnitude)
{
    return new Promise(
        function(resolve, reject)
        {
            iotaHandle.api.replayBundle(tail, depth, minWeightMagnitude,
                function(error, success) {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(success);
                    }
                }
            );
        }
    );
}