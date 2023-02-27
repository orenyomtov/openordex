const isProduction = !location.href.includes('signet')
const ordinalsExplorerUrl = isProduction ? "https://ordinals.com" : "https://explorer-signet.openordex.org"
const baseMempoolUrl = isProduction ? "https://mempool.space" : "https://mempool.space/signet"
const networkName = isProduction ? "mainnet" : "signet"
const baseMempoolApiUrl = `${baseMempoolUrl}/api`
const bitcoinPriceApiUrl = "https://blockchain.info/ticker?cors=true"
const nostrRelayUrl = 'wss://nostr.openordex.org'
const collectionsRepo = "ordinals-wallet/ordinals-collections"
const exchangeName = 'openordex'
const feeLevel = "hourFee" // "fastestFee" || "halfHourFee" || "hourFee" || "economyFee" || "minimumFee"
const dummyUtxoValue = 1_000
const txHexByIdCache = {}
const urlParams = new URLSearchParams(window.location.search)
const numberOfDummyUtxosToCreate = 1

let inscriptionIdentifier = urlParams.get('number')
let collectionSlug = urlParams.get('slug')
let inscriptionNumber
let bitcoinPrice
let recommendedFeeRate
let sellerSignedPsbt
let network
let payerUtxos
let dummyUtxo
let paymentUtxos
let inscription
let nostrRelayConnectedPromise
let nostrRelay

let listInscriptionForSale
let generateSalePsbt
let submitSignedSalePsbt
let buyInscriptionNow
let updatePayerAddress
let generateDummyUtxos
let generatePSBTGeneratingDummyUtxos
let btnBuyInscriptionNow


async function selectUtxos(utxos, amount, vins, vouts, recommendedFeeRate) {
    const selectedUtxos = []
    let selectedAmount = 0

    // Sort descending by value, and filter out dummy utxos
    utxos = utxos.filter(x => x.value > dummyUtxoValue).sort((a, b) => b.value - a.value)

    for (const utxo of utxos) {
        // Never spend a utxo that contains an inscription for cardinal purposes
        if (await doesUtxoContainInscription(utxo)) {
            continue
        }
        selectedUtxos.push(utxo)
        selectedAmount += utxo.value

        if (selectedAmount >= amount + dummyUtxoValue + calculateFee(vins + selectedUtxos.length, vouts, recommendedFeeRate)) {
            break
        }
    }

    if (selectedAmount < amount) {
        throw new Error(`Not enough cardinal spendable funds.
Address has:  ${satToBtc(selectedAmount)} BTC
Needed:          ${satToBtc(amount)} BTC`)
    }

    return selectedUtxos
}

function removeHashFromUrl() {
    const uri = window.location.toString();

    if (uri.indexOf("#") > 0) {
        const cleanUri = uri.substring(0,
            uri.indexOf("#"));

        window.history.replaceState({},
            document.title, cleanUri);
    }
}

async function getLowestPriceSellPSBGForUtxo(utxo) {
    await nostrRelayConnectedPromise
    const orders = (await nostrRelay.list([{
        kinds: [802],
        "#u": [utxo]
    }])).sort((a, b) => Number(b.tags.find(x => x?.[0] == 'p')[1]) - Number(a.tags.find(x => x?.[0] == 'p')[1]))

    for (const order of orders) {
        const price = validateSellerPSBTAndExtractPrice(order.content, utxo)
        if (price == Number(order.tags.find(x => x?.[0] == 'p')[1])) {
            return order.content
        }
    }
}

function validateSellerPSBTAndExtractPrice(sellerSignedPsbtBase64, utxo) {
    try {
        sellerSignedPsbt = bitcoin.Psbt.fromBase64(sellerSignedPsbtBase64, { network })
        const sellerInput = sellerSignedPsbt.txInputs[0]
        const sellerSignedPsbtInput = `${sellerInput.hash.reverse().toString('hex')}:${sellerInput.index}`

        if (sellerSignedPsbtInput != utxo) {
            throw `Seller signed PSBT does not match this inscription\n\n${sellerSignedPsbtInput}\n!=\n${utxo}`
        }

        if (sellerSignedPsbt.txInputs.length != 1 || sellerSignedPsbt.txInputs.length != 1) {
            throw `Invalid seller signed PSBT`
        }

        try {
            sellerSignedPsbt.extractTransaction(true)
        } catch (e) {
            if (e.message == 'Not finalized') {
                throw 'PSBT not signed'
            } else if (e.message != 'Outputs are spending more than Inputs') {
                throw 'Invalid PSBT ' + e.message || e
            }
        }

        const sellerOutput = sellerSignedPsbt.txOutputs[0]
        price = sellerOutput.value

        return Number(price)
    } catch (e) {
        console.error(e)
    }
}

function publishSellerPsbt(signedSalePsbt, inscriptionId, inscriptionUtxo, priceInSats) {
    return new Promise(async (resolve, reject) => {
        try {
            await nostrRelayConnectedPromise

            let sk = window.NostrTools.generatePrivateKey()
            let pk = window.NostrTools.getPublicKey(sk)

            let event = {
                kind: 802,
                pubkey: pk,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['n', networkName],
                    ['t', 'sell'],
                    ['i', inscriptionId],
                    ['u', inscriptionUtxo],
                    ['p', priceInSats.toString()],
                    ['e', exchangeName],
                ],
                content: signedSalePsbt,
            }
            event.id = window.NostrTools.getEventHash(event)
            event.sig = window.NostrTools.signEvent(event, sk)

            let pub = nostrRelay.publish(event)
            pub.on('ok', () => {
                console.log(`${nostrRelay.url} has accepted our order`)
                resolve()
            })
            pub.on('failed', reason => {
                reject(`Failed to publish PSBT to ${relay.url}: ${reason}`)
            })
        } catch (e) {
            reject(e)
        }
    })
}

async function doesUtxoContainInscription(utxo) {
    const html = await fetch(`${ordinalsExplorerUrl}/output/${utxo.txid}:${utxo.vout}`)
        .then(response => response.text())

    return html.match(/class=thumbnails/) !== null
}

function calculateFee(vins, vouts, recommendedFeeRate, includeChangeOutput = true) {
    const baseTxSize = 10
    const inSize = 180
    const outSize = 34

    const txSize = baseTxSize + (vins * inSize) + (vouts * outSize) + (includeChangeOutput * outSize)
    const fee = txSize * recommendedFeeRate

    return fee
}

function getExplorerLink(inscriptionId) {
    return `${ordinalsExplorerUrl}/inscription/${inscriptionId.replace(':', 'i')}`
}

async function getTxHexById(txId) {
    if (!txHexByIdCache[txId]) {
        txHexByIdCache[txId] = await fetch(`${baseMempoolApiUrl}/tx/${txId}/hex`)
            .then(response => response.text())
    }

    return txHexByIdCache[txId]
}

async function getAddressMempoolTxIds(address) {
    return await fetch(`${baseMempoolApiUrl}/address/${address}/txs/mempool`)
        .then(response => response.json())
        .then(txs => txs.map(tx => tx.txid))
}

async function getAddressUtxos(address) {
    return await fetch(`${baseMempoolApiUrl}/address/${address}/utxo`)
        .then(response => response.json())
}

function openInscription() {
    var inscriptionIdentifier = document.getElementById('inscriptionIdentifier').value;
    if (inscriptionIdentifier) {
        document.location = "inscription.html?number=" + inscriptionIdentifier;
    }
}

async function getInscriptionIdByNumber(inscriptionNumber) {
    const html = await fetch(ordinalsExplorerUrl + "/inscriptions/" + inscriptionNumber)
        .then(response => response.text())

    return html.match(/\/inscription\/(.*?)>/)[1]
}

async function getCollection(collectionSlug) {
    const [meta, inscriptions] = await Promise.all([
        fetch(`https://raw.githubusercontent.com/${collectionsRepo}/main/collections/${collectionSlug}/meta.json`)
            .then(response => response.json()),
        fetch(`https://raw.githubusercontent.com/${collectionsRepo}/main/collections/${collectionSlug}/inscriptions.json`)
            .then(response => response.json()),
    ])

    return {
        ...meta,
        inscriptions,
    }
}

async function getCollections() {
    return fetch(`/static/collections.json`)
        .then(response => response.json())
        .then(collections => collections.sort((a, b) => 0.5 - Math.random()))
}

function copyInput(btn, inputId) {
    const input = document.getElementById(inputId)
    input.select()
    input.setSelectionRange(0, 9999999)

    navigator.clipboard.writeText(input.value)

    const originalBtnTest = btn.textContent
    btn.textContent = 'Copied!'
    setTimeout(() => btn.textContent = originalBtnTest, 200)
}

function downloadInput(inputId, filename) {
    const input = document.getElementById(inputId)
    const hiddenElement = document.createElement('a');
    hiddenElement.href = 'data:attachment/text,' + encodeURI(input.value);
    hiddenElement.target = '_blank';
    hiddenElement.download = filename;
    hiddenElement.click();
}

async function getInscriptionDataById(inscriptionId, verifyIsInscriptionNumber) {
    const html = await fetch(ordinalsExplorerUrl + "/inscription/" + inscriptionId)
        .then(response => response.text())

    const data = [...html.matchAll(/<dt>(.*?)<\/dt>\s*<dd.*?>(.*?)<\/dd>/gm)]
        .map(x => { x[2] = x[2].replace(/<.*?>/gm, ''); return x })
        .reduce((a, b) => { return { ...a, [b[1]]: b[2] } }, {});

    const error = `Inscription ${verifyIsInscriptionNumber || inscriptionId} not found (maybe you're on signet and looking for a mainnet inscription or vice versa)`
    try {
        data.number = html.match(/<h1>Inscription (\d*)<\/h1>/)[1]
    } catch { throw new Error(error) }
    if (verifyIsInscriptionNumber && String(data.number) != String(verifyIsInscriptionNumber)) {
        throw new Error(error)
    }

    return data
}

function sanitizeHTML(str) {
    var temp = document.createElement('div');
    temp.textContent = str;
    return temp.innerHTML;
}

function getHashQueryStringParam(paramName) {
    const params = new URLSearchParams(window.location.hash.substr(1));
    return params.get(paramName);
}

async function generatePSBTListingInscriptionForSale(ordinalOutput, price, paymentAddress) {
    let psbt = new bitcoin.Psbt({ network });

    const [ordinalUtxoTxId, ordinalUtxoVout] = ordinalOutput.split(':')
    const tx = bitcoin.Transaction.fromHex(await getTxHexById(ordinalUtxoTxId))
    for (const output in tx.outs) {
        try { tx.setWitness(output, []) } catch { }
    }

    psbt.addInput({
        hash: ordinalUtxoTxId,
        index: parseInt(ordinalUtxoVout),
        nonWitnessUtxo: tx.toBuffer(),
        // witnessUtxo: tx.outs[ordinalUtxoVout],
        sighashType: bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY,
    });

    psbt.addOutput({
        address: paymentAddress,
        value: price,
    });

    return psbt.toBase64();
}

function btcToSat(btc) {
    return Math.floor(Number(btc) * Math.pow(10, 8))
}

function satToBtc(sat) {
    return Number(sat) / Math.pow(10, 8)
}

async function main() {
    if (window.location.pathname.startsWith('/inscription')) {
        bitcoinPrice = fetch(bitcoinPriceApiUrl)
            .then(response => response.json())
            .then(data => data.USD.last)

        recommendedFeeRate = fetch(`${baseMempoolApiUrl}/v1/fees/recommended`)
            .then(response => response.json())
            .then(data => data[feeLevel])

        if (window.NostrTools) {
            nostrRelay = window.NostrTools.relayInit(nostrRelayUrl)
            nostrRelayConnectedPromise = nostrRelay.connect()
        }

        const interval = setInterval(() => {
            if (window.bitcoin && window.secp256k1) {
                bitcoin.initEccLib(secp256k1)
                clearInterval(interval)
                inscriptionPage()
            }
        }, 50)
    } else if (window.location.pathname.startsWith('/collection')) {
        collectionPage()
    } else {
        homePage()
    }
}

async function inscriptionPage() {
    network = isProduction ? bitcoin.networks.bitcoin : bitcoin.networks.testnet

    let inscriptionID

    if (Number(inscriptionIdentifier).toString() == inscriptionIdentifier.toString()) {
        inscriptionID = await getInscriptionIdByNumber(inscriptionIdentifier);
        inscriptionNumber = inscriptionIdentifier;
    } else {
        inscriptionID = inscriptionIdentifier;
    }

    try {
        inscription = await getInscriptionDataById(inscriptionID, inscriptionNumber);
        inscriptionNumber = inscriptionNumber || inscription.number
    } catch (e) {
        return alert(e.message)
    }

    for (const span of document.getElementsByClassName('inscriptionNumber')) {
        span.textContent = inscriptionNumber;
    }

    for (const span of document.getElementsByClassName('dummyUtxoValue')) {
        span.textContent = dummyUtxoValue;
    }

    document.getElementById('preview').src = `${ordinalsExplorerUrl}/preview/${inscriptionID}`;

    document.getElementById('inscriptionId').value = inscription.id;
    document.getElementById('owner').value = inscription.address;
    document.getElementById('paymentAddress').value = inscription.address;
    document.getElementById('utxo').value = inscription.output;

    const utxoValue = satToBtc(inscription['output value'])
    document.getElementById('utxoValue').value = `${utxoValue} BTC`;
    document.getElementById('utxoValue').value += ` ($${(utxoValue * await bitcoinPrice).toFixed(2)})`;

    document.getElementById('explorerLink').href = getExplorerLink(inscription.id)

    const processSellerPsbt = async (_sellerSignedPsbt) => {
        const sellerSignedPsbtBase64 = (_sellerSignedPsbt || '').trim().replaceAll(' ', '+')
        if (sellerSignedPsbtBase64) {
            sellerSignedPsbt = bitcoin.Psbt.fromBase64(sellerSignedPsbtBase64, { network })
            const sellerInput = sellerSignedPsbt.txInputs[0]
            const sellerSignedPsbtInput = `${sellerInput.hash.reverse().toString('hex')}:${sellerInput.index}`

            if (sellerSignedPsbtInput != inscription.output) {
                throw `Seller signed PSBT does not match this inscription\n\n${sellerSignedPsbtInput}\n!=\n${inscription.output}`
            }

            if (sellerSignedPsbt.txInputs.length != 1 || sellerSignedPsbt.txInputs.length != 1) {
                throw `Invalid seller signed PSBT`
            }

            const sellerOutput = sellerSignedPsbt.txOutputs[0]
            price = sellerOutput.value
            const sellerOutputValueBtc = satToBtc(price)
            const sellPriceText = `${sellerOutputValueBtc} BTC ($${(sellerOutputValueBtc * await bitcoinPrice).toFixed(2)})`
            document.getElementById('btnBuyInscriptionNow').style.display = 'revert'
            document.getElementById('btnBuyInscriptionNow').textContent = `Buy Inscription ${inscriptionNumber} Now For ${sellPriceText}`

            for (const span of document.getElementsByClassName('price')) {
                span.textContent = sellPriceText;
            }
        }
    }

    listInscriptionForSale = async () => {
        document.getElementById('listDialog').showModal()
    }

    let price
    let psbt

    generateSalePsbt = async () => {
        price = Number(document.getElementById('price').value)
        const paymentAddress = document.getElementById('paymentAddress').value
        psbt = await generatePSBTListingInscriptionForSale(inscription.output, btcToSat(price), paymentAddress)

        document.getElementById('saleStep1').style.display = 'none'
        document.getElementById('saleStep2').style.display = 'revert'

        for (const span of document.getElementsByClassName('price')) {
            span.textContent = price;
        }

        document.getElementById('generatedSalePsbt').value = psbt
    }

    submitSignedSalePsbt = async () => {
        const btn = document.getElementById('btnSubmitSignedSalePsbt')
        const originalBtnTest = btn.textContent
        btn.textContent = 'Submitting...'
        document.getElementById('btnSubmitSignedSalePsbt').disabled = true

        setTimeout(async () => {
            const signedContent = document.getElementById('signedSalePsbt').value
            let signedSalePsbt
            if (signedContent.startsWith('02000000') || signedContent.startsWith('01000000')) {
                const sellerSignedTx = bitcoin.Transaction.fromHex(signedContent)
                const sellerSignedInput = sellerSignedTx.ins[0]
                signedSalePsbt = bitcoin.Psbt.fromBase64(psbt, { network })

                if (sellerSignedInput?.script?.length) {
                    signedSalePsbt.updateInput(0, {
                        finalScriptSig: sellerSignedInput.script,
                    })
                }
                if (sellerSignedInput?.witness?.[0]?.length) {
                    signedSalePsbt.updateInput(0, {
                        finalScriptWitness: witnessStackToScriptWitness(sellerSignedInput.witness),
                    })
                }

                signedSalePsbt = signedSalePsbt.toBase64()
            } else {
                signedSalePsbt = document.getElementById('signedSalePsbt').value
            }

            try {
                bitcoin.Psbt.fromBase64(signedSalePsbt, { network }).extractTransaction(true)
            } catch (e) {
                if (e.message == 'Not finalized') {
                    return alert('Please sign and finalize the PSBT before submitting it')
                } else if (e.message != 'Outputs are spending more than Inputs') {
                    console.error(e)
                    return alert('Invalid PSBT', e.message || e)
                }
            }
            document.location.hash = 'sellerSignedPsbt=' + signedSalePsbt

            if (document.getElementById('publicPsbt').checked) {
                try {
                    await publishSellerPsbt(signedSalePsbt, inscription.id, inscription.output, btcToSat(price))
                    removeHashFromUrl()
                    return window.location.reload()
                } catch (e) {
                    console.error(e)
                    alert('Error publishing seller PSBT', e.message || e)
                }
            }

            document.getElementById('btnSubmitSignedSalePsbt').textContent = originalBtnTest
            document.getElementById('listDialog').close()
            try {
                processSellerPsbt(getHashQueryStringParam('sellerSignedPsbt'))
            } catch (e) {
                alert(e)
            }
        }, 350)
    }

    buyInscriptionNow = async () => {
        document.getElementById('payerAddress').value = localStorage.getItem('payerAddress') || ''
        if (document.getElementById('payerAddress').value) {
            updatePayerAddress()
        }
        document.getElementById('receiverAddress').value = localStorage.getItem('receiverAddress') || ''

        document.getElementById('buyDialog').showModal()
    }

    function hideDummyUtxoElements() {
        for (const el of document.getElementsByClassName('notDummy')) {
            el.style.display = 'revert'
        }

        for (const el of document.getElementsByClassName('dummy')) {
            el.style.display = 'none'
        }
    }

    function showDummyUtxoElements() {
        for (const el of document.getElementsByClassName('notDummy')) {
            el.style.display = 'none'
        }

        for (const el of document.getElementsByClassName('dummy')) {
            el.style.display = 'revert'
        }
    }

    updatePayerAddress = async () => {
        const payerAddress = document.getElementById('payerAddress').value
        document.getElementById('receiverAddress').placeholder = payerAddress;
        localStorage.setItem('payerAddress', payerAddress)

        document.getElementById('loadingUTXOs').style.display = 'block'
        try {
            payerUtxos = await getAddressUtxos(payerAddress)
        } catch (e) {
            document.getElementById('payerAddress').classList.add('is-invalid')
            document.getElementById('btnBuyInscription').disabled = true
            hideDummyUtxoElements()
            return console.error(e)
        } finally {
            document.getElementById('loadingUTXOs').style.display = 'none'
        }

        const potentialDummyUtxos = payerUtxos.filter(utxo => utxo.value <= dummyUtxoValue)
        dummyUtxo = undefined

        for (const potentialDummyUtxo of potentialDummyUtxos) {
            if (!(await doesUtxoContainInscription(potentialDummyUtxo))) {
                hideDummyUtxoElements()
                dummyUtxo = potentialDummyUtxo
                break
            }
        }

        let minimumValueRequired
        let vins
        let vouts

        if (!dummyUtxo) {
            showDummyUtxoElements()

            minimumValueRequired = (numberOfDummyUtxosToCreate * dummyUtxoValue)
            vins = 0
            vouts = numberOfDummyUtxosToCreate
        } else {
            hideDummyUtxoElements()

            minimumValueRequired = price + (numberOfDummyUtxosToCreate * dummyUtxoValue)
            vins = 1
            vouts = 2 + numberOfDummyUtxosToCreate
        }

        try {
            paymentUtxos = await selectUtxos(payerUtxos, minimumValueRequired, vins, vouts, await recommendedFeeRate)
        } catch (e) {
            paymentUtxos = undefined
            console.error(e)
            document.getElementById('payerAddress').classList.add('is-invalid')
            document.getElementById('btnBuyInscription').disabled = true
            return alert(e)
        }

        document.getElementById('payerAddress').classList.remove('is-invalid')
        document.getElementById('btnBuyInscription').disabled = false
    }

    document.getElementById('btnGenerateDummyUtxos').onclick = async () => {
        const payerAddress = document.getElementById('payerAddress').value

        psbt = await generatePSBTGeneratingDummyUtxos(payerAddress, numberOfDummyUtxosToCreate, paymentUtxos)

        await displayBuyPsbt(psbt, payerAddress, `Sign and broadcast this transaction to create a dummy UTXO`, `Dummy UTXO created successfully! Refresh the page to buy the inscription.`)
    }

    generatePSBTGeneratingDummyUtxos = async (payerAddress, numberOfDummyUtxosToCreate, payerUtxos) => {
        const psbt = new bitcoin.Psbt({ network });
        let totalValue = 0

        for (const utxo of payerUtxos) {
            const tx = bitcoin.Transaction.fromHex(await getTxHexById(utxo.txid))
            for (const output in tx.outs) {
                try { tx.setWitness(output, []) } catch { }
            }
            psbt.addInput({
                hash: utxo.txid,
                index: utxo.vout,
                nonWitnessUtxo: tx.toBuffer(),
                // witnessUtxo: tx.outs[utxo.vout],
            });

            totalValue += utxo.value
        }

        for (let i = 0; i < numberOfDummyUtxosToCreate; i++) {
            psbt.addOutput({
                address: payerAddress,
                value: dummyUtxoValue,
            });
        }

        const fee = calculateFee(psbt.txInputs.length, psbt.txOutputs.length, await recommendedFeeRate)

        // Change utxo
        psbt.addOutput({
            address: payerAddress,
            value: totalValue - (numberOfDummyUtxosToCreate * dummyUtxoValue) - fee,
        });

        return psbt.toBase64();
    }

    generatePSBTBuyingInscription = async (payerAddress, receiverAddress, price, paymentUtxos, dummyUtxo) => {
        const psbt = new bitcoin.Psbt({ network });
        let totalValue = 0
        let totalPaymentValue = 0

        // Add dummy utxo input
        const tx = bitcoin.Transaction.fromHex(await getTxHexById(dummyUtxo.txid))
        for (const output in tx.outs) {
            try { tx.setWitness(output, []) } catch { }
        }
        psbt.addInput({
            hash: dummyUtxo.txid,
            index: dummyUtxo.vout,
            nonWitnessUtxo: tx.toBuffer(),
            // witnessUtxo: tx.outs[dummyUtxo.vout],
        });

        // Add inscription output
        psbt.addOutput({
            address: receiverAddress,
            value: dummyUtxo.value + Number(inscription['output value']),
        });

        // Add payer signed input
        psbt.addInput({
            ...sellerSignedPsbt.data.globalMap.unsignedTx.tx.ins[0],
            ...sellerSignedPsbt.data.inputs[0]
        })
        // Add payer output
        psbt.addOutput({
            ...sellerSignedPsbt.data.globalMap.unsignedTx.tx.outs[0],
        })

        // Add payment utxo inputs
        for (const utxo of paymentUtxos) {
            const tx = bitcoin.Transaction.fromHex(await getTxHexById(utxo.txid))
            for (const output in tx.outs) {
                try { tx.setWitness(output, []) } catch { }
            }

            psbt.addInput({
                hash: utxo.txid,
                index: utxo.vout,
                nonWitnessUtxo: tx.toBuffer(),
                // witnessUtxo: tx.outs[utxo.vout],
            });

            totalValue += utxo.value
            totalPaymentValue += utxo.value
        }

        // Create a new dummy utxo output for the next purchase
        psbt.addOutput({
            address: payerAddress,
            value: dummyUtxoValue,
        })

        const fee = calculateFee(psbt.txInputs.length, psbt.txOutputs.length, await recommendedFeeRate)

        const changeValue = totalValue - dummyUtxo.value - price - fee

        if (changeValue < 0) {
            throw `Your wallet address doesn't have enough funds to buy this inscription.
Price:          ${satToBtc(price)} BTC
Fees:       ${satToBtc(fee + dummyUtxoValue)} BTC
You have:   ${satToBtc(totalPaymentValue)} BTC
Required:   ${satToBtc(totalValue - changeValue)} BTC
Missing:     ${satToBtc(-changeValue)} BTC`
        }

        // Change utxo
        psbt.addOutput({
            address: payerAddress,
            value: changeValue,
        });

        return psbt.toBase64();
    }

    displayBuyPsbt = async (psbt, payerAddress, title, successMessage) => {
        document.getElementById('buyStep1').style.display = 'none'
        document.getElementById('buyStep2').style.display = 'revert'

        document.getElementById('generatedBuyPsbtTitle').textContent = title
        document.getElementById('generatedBuyPsbt').value = psbt;
        (new QRCode('buyPsbtQrCode', { width: 300, height: 300, correctLevel: QRCode.CorrectLevel.L })).makeCode(psbt)


        const payerCurrentMempoolTxIds = await getAddressMempoolTxIds(payerAddress)
        const interval = setInterval(async () => {
            const txId = (await getAddressMempoolTxIds(payerAddress)).find(txId => !payerCurrentMempoolTxIds.includes(txId))

            if (txId) {
                clearInterval(interval)
                document.getElementById('buyStatusMessage').innerHTML = `${successMessage}
<br><br>
See transaction details on <a href="${baseMempoolUrl}/tx/${txId}" target="_blank">block explorer</a>.`
            }
        }, 5_000)
    }

    document.getElementById('btnBuyInscription').onclick = async () => {
        const receiverAddress = document.getElementById('receiverAddress').value || document.getElementById('receiverAddress').placeholder
        const payerAddress = document.getElementById('payerAddress').value

        try {
            psbt = await generatePSBTBuyingInscription(payerAddress, receiverAddress, price, paymentUtxos, dummyUtxo)
        } catch (e) {
            return alert(e)
        }

        const sellerOutputValueBtc = satToBtc(price)
        const sellPriceText = `${sellerOutputValueBtc} BTC ($${(sellerOutputValueBtc * await bitcoinPrice).toFixed(2)})`
        await displayBuyPsbt(psbt, payerAddress, `Sign and broadcast this transaction to buy inscription #${inscriptionNumber} for ${sellPriceText}`, `Success! Inscription #${inscriptionNumber} bought successfully for ${sellPriceText}!`)
    }

    sellerSignedPsbt = getHashQueryStringParam('sellerSignedPsbt')
    if (!sellerSignedPsbt) {
        sellerSignedPsbt = await getLowestPriceSellPSBGForUtxo(inscription.output)
    }
    if (sellerSignedPsbt) {
        try {
            processSellerPsbt(sellerSignedPsbt)
        } catch (e) {
            alert(e)
        }
    }
}

async function collectionPage() {
    try {
        const collection = await getCollection(collectionSlug)

        document.getElementById('collectionName').textContent = collection.name
        document.getElementById('supply').textContent = `${collection.inscriptions.length}/${collection.supply}`
        document.getElementById('collectionIcon').src = `${ordinalsExplorerUrl}/preview/${collection.inscription_icon}`
        document.getElementById('collectionDescription').textContent = collection.description.replaceAll("\n", "<br>")

        if (collection.twitter_link) {
            document.getElementById('twitter').href = collection.twitter_link
            document.getElementById('twitter').style.display = 'revert'
        }
        if (collection.discord_link) {
            document.getElementById('discord').href = collection.discord_link
            document.getElementById('discord').style.display = 'revert'
        }
        if (collection.website_link) {
            document.getElementById('website').href = collection.website_link
            document.getElementById('website').style.display = 'revert'
        }

        const inscriptionsContainer = document.getElementById('inscriptionsContainer')

        for (const inscription of collection.inscriptions) {
            const inscriptionElement = document.createElement('a')
            inscriptionElement.href = `/inscription.html?number=${inscription.id}`
            inscriptionElement.target = `_blank`
            inscriptionElement.innerHTML = `
                <div class="card card-tertiary w-100 fmxw-300">
                    <div class="card-header text-center">
                        <span id="inscriptionName">${sanitizeHTML(inscription.meta.name)}</span>
                    </div>
                    <div class="card-body" style="padding: 6px 7px 7px 7px">
                        <iframe id="collectionIcon" style="pointer-events: none" sandbox=allow-scripts
                            scrolling=no loading=lazy
                            src="${ordinalsExplorerUrl}/preview/${inscription.id.replaceAll('"', '')}"></iframe>
                    </div>
                </div>`
            inscriptionsContainer.appendChild(inscriptionElement)
        }
    } catch (e) {
        console.error(e)
        alert(`Error fetching collection ${collectionSlug}:\n` + e.message)
    }
}

async function homePage() {
    try {
        const collections = await getCollections()

        const collectionsContainer = document.getElementById('collectionsContainer')

        for (const collection of collections) {
            const collectionElement = document.createElement('a')
            collectionElement.href = `/collection.html?slug=${collection.slug}`
            collectionElement.target = `_blank`
            collectionElement.innerHTML = `
                <div class="card card-tertiary w-100 fmxw-300">
                    <div class="card-header text-center">
                        <span id="inscriptionName">${sanitizeHTML(collection.name)}</span>
                    </div>
                    <div class="card-body" style="padding: 6px 7px 7px 7px">
                        <iframe id="collectionIcon" style="pointer-events: none" sandbox=allow-scripts
                            scrolling=no loading=lazy
                            src="${ordinalsExplorerUrl}/preview/${collection.inscription_icon.replaceAll('"', '')}"></iframe>
                    </div>
                </div>`
            collectionsContainer.appendChild(collectionElement)
        }
    } catch (e) {
        console.error(e)
        console.error(`Error fetching collections:\n` + e.message)
    }
}

main()

const currDate = new Date()
const hoursMin = currDate.getHours().toString().padStart(2, '0') + ':' + currDate.getMinutes().toString().padStart(2, '0')
document.getElementById('time').textContent = hoursMin

if (!isProduction) {
    document.getElementById('networkName').textContent = '(Signet)'
}
