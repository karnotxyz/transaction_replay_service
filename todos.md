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
 