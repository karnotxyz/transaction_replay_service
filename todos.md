1 -> 
  - remove redis as a dependency, rather use a simple file write.
  
  - when the service is requested via rpc to replay it writes to a file, that it's running.
  - before each new block, it reads the file and if it's in running state it continues.
  
  - upon every new npm run start, the service checks if the file exists, if it doesn't then don't replay till asked via rpc call, 
  if the file exits and it says running, then call syncing node to see what is it's current state, validate that the parent hash matches that of the original node and then continue.
  else if the file says not syncing, do not replay till asked via rpc
  
  this is a basic replay service that takes transactions from 1 blockchain node and sends them to another blockchain node.
  
  let's simplify this as much as possible, this is the first task - remove redis dep and use a file write.


2 -> 
 - the codebase has very complex structure when we talk about syncing and snapsyncing, the story is that initially we had normal sync -> used to wait for receipt after each transaction and then send the other and snapsync -> sends all the transaction with a very small time delay and then waits for all of them together, over time we didn't need the sync and only required snapsync, but we only half-removed syncing, we need to fully remove syncing and only keep snapsyncing. and rename snap sync to syncing, no need to glorify the word snap.
 
 
 3 -> 
 - the codebase doesn't log properly for each call failure, let's say that getlatestblock failed for syncing node, the code will log that the fn getlatestblock failed. but not that for which node it failed, it should log that for which node it failed.
 
 4 -> 
 - when the ranged syncing is completed it logs from and to, i think there's a bug that to is - 1 the number it actually synced till.
 
 
 5-> 
 ensure that the latest block fetching probe works properly and completely parallel to the core functionality of the code and it only needs to work when we've called for continuous sync. 
 
 6 -> 
 I think we are re-querying the nodes for data in places that we already have because of the previous call to them, can you find if this is still happening? 
 maybe we could optimise on the calls it's making to the nodes.
 
 7->
 hopefully by now the code is much cleaner and smaller than it was before.
 let's work on more optimisations that you feel are needed and make this service prod ready.
