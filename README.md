# OpenOrdex - Open Ordinals Decentralized Exchange

OpenOrdex is an open source zero-fee trustless Bitcoin NFT marketplace based on partially signed bitcoin transactions

## How it works
The seller creates a partially signed bitcoin transaction (PSBT) specifying the price of the ordinal.  
The buyer can then sign the PSBT and broadcast it to the network.

## How to add your collection
All inscriptions can be viewed directly via their inscription number or ID.

In addition, the homepage features collections in a random order.  
The collection data is taken from the [ordinal-collections](https://github.com/ordinals-wallet/ordinals-collections) repo.  

In order to have your collection listed, create a pull request on the [ordinal-collections](https://github.com/ordinals-wallet/ordinals-collections) repo.

## How to run Openordex in your localhost

Build docker image
```
$ docker build -t openordex .
```

Run Openordex with docker
```
$ docker run -it -d -p 8080:80 openordex
```
<img width="1057" alt="Screen Shot 2023-03-06 at 9 40 15 AM" src="https://user-images.githubusercontent.com/115091323/223142708-3eb0e8d7-08d7-4854-9d3f-32ddda7f975d.png">
