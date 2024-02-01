# NIP-?

## Inscription Order
`draft` `optional` `ordinals` `psbt` `orderbook` `author:orenyomtov`

An inscription order is a `kind 802` event that is used to publish a signed order to buy or sell a specific ordinal inscription.

# Event Content

`event.content` is the Partially Signed Bitcoin Transaction (PSBT) encoded in base64.

# Tags
The following tags are included in the event:

* n: Network name (e.g. "mainnet", "testnet").
* t: Type of order (e.g. "sell", "buy").
* i: Inscription ID.
* u: Inscription UTXO.
* s: Price in sats as a string.
* x: Exchange name (e.g. "openordex").

# Verification
The client should verify that the following conditions are met:
* The PSBT is valid and signed.
  * For a sell order, the PSBT should have a single input and single output and signed with SIGHASH_SINGLE | ANYONECANPAY
  * For a buy order, all inputs should be signed except the input that contains the inscription, which will be unsigned.
* The UTXO in which the inscription currently resides is the same as the one in the event.
* The UTXO in the event is the same as the one in the PSBT.
* The price in the event is the same as the output value in the PSBT.

# Example code
Below is an example code snippet that creates an inscription order event:

```js
function createOrderEvent(pubkey, networkName, orderType, inscriptionId, inscriptionUtxo, priceInSats, exchangeName, signedSalePsbt) {
  const event = {
    kind: 802,
    pubkey: pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['n', networkName],
      ['t', orderType],
      ['i', inscriptionId],
      ['u', inscriptionUtxo],
      ['s', priceInSats],
      ['x', exchangeName],
    ],
    content: signedSalePsbt,
  };

  return event;
};
