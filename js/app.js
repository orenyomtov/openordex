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
const nostrOrderEventKind = 802
const txHexByIdCache = {}
const urlParams = new URLSearchParams(window.location.search)

let takerUtxos = []
let paddingUtxos = []
let inscriptionIdentifier = urlParams.get('number')
let collectionSlug = urlParams.get('slug')
let inscriptionNumber
let bitcoinPrice
let recommendedFeeRate
let sellerSignedPsbt
let network
let payerUtxos
let paymentUtxos
let inscription
let nostrRelay
let bitcoinInitializedPromise

let listInscriptionForSale
let generateSalePsbt
let submitSignedSalePsbt
let buyInscriptionNow
let updatePayerAddress
let btnBuyInscriptionNow


async function selectUtxos(utxos, amount, vins, vouts, recommendedFeeRate, inscription) {
    takerUtxos = []
    paddingUtxos = []
    takerUtxos.length = 0
    paddingUtxos.length = 0
    let takerUtxosAmount = 0
    let paddingUtxosAmount = 0
    let additionalVouts = 0
    let takerPaddingRequired = false
    let estimatedFee = 0
    let inscriptionOutputValue = Number(inscription["output value"])

    // Sort descending by value greater than amount
    utxos = utxos.filter(x => x.value).sort((a, b) => b.value - a.value)

    for (const utxo of utxos) {

        // Never spend a utxo that contains an inscription for cardinal purposes
        console.log(utxos)
        if (await doesUtxoContainInscription(utxo)) {
            continue
        }

        estimatedFee = calculateFee(vins + takerUtxos.length + paddingUtxos.length, vouts + additionalVouts, recommendedFeeRate)

        if (inscriptionOutputValue - estimatedFee + paddingUtxosAmount < 2000) {
            paddingUtxos.push(utxo)
            paddingUtxosAmount += utxo.value
            if (!takerPaddingRequired) {
                takerPaddingRequired = true
                additionalVouts++
            }
        } else if (takerUtxosAmount < amount) {
            takerUtxos.push(utxo)
            takerUtxosAmount += utxo.value
            additionalVouts++
        }

        if (amount < takerUtxosAmount && inscriptionOutputValue + paddingUtxosAmount - estimatedFee > 2546) {
            break
        }

    }

    if (inscriptionOutputValue + paddingUtxosAmount - estimatedFee < 2546) {
        throw new Error(`Not enough cardinal spendable funds to support the necessary padding.
Address has:  ${satToBtc(paddingUtxosAmount)} BTC to pad the inscription
Needed:          ${satToBtc(5546 - inscriptionOutputValue + calculateFee(vins + takerUtxos.length + paddingUtxos.length + 1, vouts + additionalVouts, recommendedFeeRate))} BTC`)
    }

    if (takerUtxosAmount < amount + 546) {
        throw new Error(`Not enough cardinal spendable funds.
Address has:  ${satToBtc(takerUtxosAmount)} BTC
Needed:          ${satToBtc(amount + estimatedFee)} BTC`)
    }

    return [takerUtxos, paddingUtxos]
}

function base64ToHex(str) {
    return atob(str).split("")
        .map(c => c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("");
}

async function getWalletAddress() {
    if (typeof window.unisat !== 'undefined') {
        return (await unisat.requestAccounts())[0]
    }
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
    await nostrRelay.connect()
    const orders = (await nostrRelay.list([{
        kinds: [nostrOrderEventKind],
        "#u": [utxo]
    }])).filter(a => a.tags.find(x => x?.[0] == 's')?.[1])
        .sort((a, b) => Number(a.tags.find(x => x?.[0] == 's')[1]) - Number(b.tags.find(x => x?.[0] == 's')[1]))

    for (const order of orders) {
        const price = validateSellerPSBTAndExtractPrice(order.content, utxo)
        if (price == Number(order.tags.find(x => x?.[0] == 's')[1])) {
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

function publishSellerPsbt(signedSalePsbt, inscriptionId, inscriptionNumber, inscriptionUtxo, priceInSats) {
    return new Promise(async (resolve, reject) => {
        try {
            await nostrRelay.connect()

            let sk = window.NostrTools.generatePrivateKey()
            let pk = window.NostrTools.getPublicKey(sk)

            let event = {
                kind: nostrOrderEventKind,
                pubkey: pk,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['n', networkName], // Network name (e.g. "mainnet", "signet")
                    ['t', 'sell'], // Type of order (e.g. "sell", "buy")
                    ['i', inscriptionId], // Inscription ID
                    ['m', inscriptionNumber], // Inscription number
                    ['u', inscriptionUtxo], // Inscription UTXO
                    ['s', priceInSats.toString()], // Price in sats
                    ['x', exchangeName], // Exchange name (e.g. "openordex")
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
    if (collectionSlug == 'under-1k') {
        return await fetch(`/static/under-1k.json`).then(response => response.json())
    }

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

function satsToFormattedDollarString(sats, _bitcoinPrice) {
    return (satToBtc(sats) * _bitcoinPrice).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })
}

async function* getLatestOrders(limit, nostrLimit = 20, filters = {}) {
    await nostrRelay.connect()
    const latestOrders = []
    const inscriptionDataCache = {}

    const orders = await nostrRelay.list([{
        kinds: [nostrOrderEventKind],
        limit: nostrLimit,
        ...filters,
    }])

    for (const order of orders) {
        try {
            if (!order.tags.find(x => x?.[0] == 's')?.[1]) {
                continue
            }
            const inscriptionId = order.tags.find(x => x?.[0] == 'i')[1]
            if (latestOrders.find(x => x.inscriptionId == inscriptionId)) {
                continue
            }

            const inscriptionData = inscriptionDataCache[inscriptionId] || await getInscriptionDataById(inscriptionId)
            inscriptionDataCache[inscriptionId] = inscriptionData
            const validatedPrice = validateSellerPSBTAndExtractPrice(order.content, inscriptionData.output)
            if (!validatedPrice) {
                continue
            }

            const ord = {
                title: `Buy for ${satToBtc(validatedPrice)} BTC ($${satsToFormattedDollarString(validatedPrice, await bitcoinPrice)})`,
                number: inscriptionData.number,
                inscriptionId,
            }
            latestOrders.push(ord)
            yield ord

            if (latestOrders.length >= limit) {
                break
            }
        } catch (e) {
            console.error(e)
        }
    }

    return latestOrders
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

async function signPSBTUsingWallet(inputId, signedInputId) {
    const input = document.getElementById(inputId)
    const signedInput = document.getElementById(signedInputId)

    try {
        await unisat.requestAccounts()
        signedInput.value = await unisat.signPsbt(base64ToHex(input.value))
    } catch (e) {
        console.error(e)
        alert(e.message)
    }
}

async function signPSBTUsingWalletAndBroadcast(inputId) {
    const input = document.getElementById(inputId)

    try {
        await unisat.requestAccounts()
        const signedPsbt = await unisat.signPsbt(base64ToHex(input.value))
        const txHex = bitcoin.Psbt.fromHex(signedPsbt).extractTransaction().toHex()

        const res = await fetch(`${baseMempoolApiUrl}/tx`, { method: 'post', body: txHex })
        if (res.status != 200) {
            return alert(`Mempool API returned ${res.status} ${res.statusText}\n\n${await res.text()}`)
        }

        const txId = res.text()
        alert('Transaction signed and broadcasted to mempool successfully')
        window.open(`${baseMempoolUrl}/tx/${txId}`, "_blank")
    } catch (e) {
        console.error(e)
        alert(e)
    }
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
        try { tx.setWitness(parseInt(output), []) } catch { }
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
    bitcoinPrice = fetch(bitcoinPriceApiUrl)
        .then(response => response.json())
        .then(data => data.USD.last)

    if (window.NostrTools) {
        nostrRelay = window.NostrTools.relayInit(nostrRelayUrl)
        nostrRelay.connect()
    }

    bitcoinInitializedPromise = new Promise(resolve => {
        const interval = setInterval(() => {
            if (window.bitcoin && window.secp256k1) {
                bitcoin.initEccLib(secp256k1)
                clearInterval(interval)
                resolve()
            }
        }, 50)
    })

    if (window.location.pathname.startsWith('/inscription')) {
        recommendedFeeRate = fetch(`${baseMempoolApiUrl}/v1/fees/recommended`)
            .then(response => response.json())
            .then(data => data[feeLevel])
        inscriptionPage()
    } else if (window.location.pathname.startsWith('/collections')) {
        collectionsPage()
    } else if (window.location.pathname.startsWith('/collection')) {
        collectionPage()
    } else if (window.location.pathname.startsWith('/listings')) {
        listingsPage()
    } else {
        homePage()
    }
}

async function inscriptionPage() {
    await bitcoinInitializedPromise
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

        if (typeof window.unisat !== 'undefined') {
            document.getElementById('btnSignWithWallet').style.display = 'revert'
        }
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
            } else if (signedContent.match(/^[0-9a-fA-F]+$/)) {
                signedSalePsbt = bitcoin.Psbt.fromHex(signedContent, { network }).toBase64()
            } else {
                signedSalePsbt = document.getElementById('signedSalePsbt').value
            }

            try {
                bitcoin.Psbt.fromBase64(signedSalePsbt, { network }).extractTransaction(true)
            } catch (e) {
                console.error(e)
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
                    await publishSellerPsbt(signedSalePsbt, inscription.id, inscription.number, inscription.output, btcToSat(price))
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
        document.getElementById('payerAddress').value = localStorage.getItem('payerAddress') || await getWalletAddress() || ''
        if (document.getElementById('payerAddress').value) {
            updatePayerAddress()
        }
        document.getElementById('receiverAddress').value = localStorage.getItem('receiverAddress') || await getWalletAddress() || ''

        document.getElementById('buyDialog').showModal()
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
            return console.error(e)
        } finally {
            document.getElementById('loadingUTXOs').style.display = 'none'
        }

        let minimumValueRequired = price
        let vins = 2
        let vouts = 3

        try {
            const [takerUtxos, paddingUtxos] = await selectUtxos(payerUtxos, minimumValueRequired, vins, vouts, await recommendedFeeRate, inscription)
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



    generatePSBTBuyingInscription = async (payerAddress, receiverAddress, price, takerUtxos, paddingUtxos) => {
        const psbt = new bitcoin.Psbt({ network });

        // add payment inputs
        for (utxo of takerUtxos) {
            psbt.addInput({
                hash: utxo.txid,
                index: utxo.vout,
                nonWitnessUtxo: bitcoin.Transaction.fromHex(await getTxHexById(utxo.txid)).toBuffer()
            })
        }

        let inscriptionUtxoValue = Number(inscription['output value'])

        // add inscription input
        psbt.addInput({
            ...sellerSignedPsbt.data.globalMap.unsignedTx.tx.ins[0],
            ...sellerSignedPsbt.data.inputs[0]
        })


        // add padding inputs
        for (utxo of paddingUtxos) {
            psbt.addInput({
                hash: utxo.txid,
                index: utxo.vout,
                nonWitnessUtxo: bitcoin.Transaction.fromHex(await getTxHexById(utxo.txid)).toBuffer()
            })
        }

        // add change outputs
        let sumOfTakerUtxos = 0
        takerUtxos.forEach(u => sumOfTakerUtxos += u.value)
        let remainingTakerUtxoChange = sumOfTakerUtxos - price

        for (let i = 0; i < takerUtxos.length; i++) {
            if (i < takerUtxos.length - 1) {
                psbt.addOutput({
                    address: payerAddress,
                    value: Math.ceil((sumOfTakerUtxos - price) / takerUtxos.length)
                })
                remainingTakerUtxoChange -= Math.ceil((sumOfTakerUtxos - price) / takerUtxos.length)
            } else {
                psbt.addOutput({
                    address: payerAddress,
                    value: remainingTakerUtxoChange
                })
            }
        }

        // add payment output
        psbt.addOutput({
            ...sellerSignedPsbt.data.globalMap.unsignedTx.tx.outs[0]
        })



        const fee = calculateFee(psbt.txInputs.length, psbt.txOutputs.length, await recommendedFeeRate)
        let remainingPaddingValue = 0
        paddingUtxos.forEach(u => remainingPaddingValue += u.value)

        // If no added padding available, and safe to send with current fee, then send
        if (!paddingUtxos.length && inscriptionUtxoValue - fee > 2000) {
            psbt.addOutput({
                address: receiverAddress,
                value: inscriptionUtxoValue - fee
            })
        // If safe to proceed with available padding, then send
        } else if (inscriptionUtxoValue + remainingPaddingValue - fee < 10000 && inscriptionUtxoValue + remainingPaddingValue - fee > 2000) {
            psbt.addOutput({
                address: receiverAddress,
                value: inscriptionUtxoValue + remainingPaddingValue - fee
            })
        // If padding available to reset the 10k threshold, reset and spend change to receiver
        } else if (inscriptionUtxoValue + remainingPaddingValue - fee > 10000) {
            psbt.addOutput({
                address: receiverAddress,
                value: inscriptionUtxoValue > 10000 ? inscriptionUtxoValue : 10000
            })

            remainingPaddingValue -= (10000 - inscriptionUtxoValue) + fee

            psbt.addOutput({
                address: receiverAddress,
                value: remainingPaddingValue - fee
            })
        } else {
            throw new Error(`Fee markets are currently very volatile.  Please add additional funds or wait.`)
        }

        return psbt.toBase64();
    }

    displayBuyPsbt = async (psbt, payerAddress, title, successMessage) => {
        document.getElementById('buyStep1').style.display = 'none'
        document.getElementById('buyStep2').style.display = 'revert'

        document.getElementById('generatedBuyPsbtTitle').textContent = title
        document.getElementById('generatedBuyPsbt').value = psbt;
        (new QRCode('buyPsbtQrCode', { width: 300, height: 300, correctLevel: QRCode.CorrectLevel.L })).makeCode(psbt)

        if (typeof window.unisat !== 'undefined') {
            document.getElementById('btnBuySignWithWalletAndBroadcast').style.display = 'revert'
        }

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
            psbt = await generatePSBTBuyingInscription(payerAddress, receiverAddress, price, takerUtxos, paddingUtxos)
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
        let collection
        try {
            collection = await getCollection(collectionSlug)
        } catch {
            throw new Error(`Collection ${collectionSlug} not found`)
        }

        document.getElementById('collectionName').textContent = collection.name
        document.title = collection.name
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
            inscriptionElement.className = `collectionLink`
            inscriptionElement.innerHTML = `
                <div class="card card-tertiary w-100 fmxw-300">
                    <div class="card-header text-center">
                        <span id="inscriptionName">${sanitizeHTML(inscription.meta.name)}</span>
                    </div>
                    <div class="card-body" style="padding: 6px 7px 7px 7px" id="inscription_${inscription.id}">
                        <iframe style="pointer-events: none" sandbox=allow-scripts
                            scrolling=no loading=lazy
                            src="${ordinalsExplorerUrl}/preview/${inscription.id.replaceAll('"', '')}"></iframe>
                    </div>
                </div>`
            inscriptionsContainer.appendChild(inscriptionElement)
        }

        const orders = getLatestOrders(collection.inscriptions.length, collection.inscriptions.length * 2, { "#i": collection.inscriptions.map(x => x.id) })

        for await (const order of orders) {
            const button = document.createElement('button')
            button.className = "btn btn-block btn-primary mt-2"
            button.setAttribute('style', 'max-width:185px; max-height: revert')
            button.textContent = order.title

            document.getElementById(`inscription_${order.inscriptionId}`).appendChild(button)
            inscriptionElement = document.getElementById(`inscription_${order.inscriptionId}`).parentElement.parentElement
            inscriptionElement.parentElement.insertBefore(inscriptionElement, inscriptionElement.parentElement.firstChild);
        }
    } catch (e) {
        console.error(e)
        alert(`Error fetching collection ${collectionSlug}:\n` + e.message)
    } finally {
        document.getElementById('listingsLoading').style.display = 'none'
    }
}

function displayCollections(displayedCollections) {
    const collectionsContainer = document.getElementById('collectionsContainer')
    collectionsContainer.innerHTML = ''

    for (const collection of displayedCollections) {
        const collectionElement = document.createElement('a')
        collectionElement.href = `/collection.html?slug=${collection.slug}`
        collectionElement.target = `_blank`
        collectionElement.innerHTML = `
            <div class="card card-tertiary w-100 fmxw-300">
                <div class="card-header text-center">
                    <span>${sanitizeHTML(collection.name)}</span>
                </div>
                <div class="card-body" style="padding: 6px 7px 7px 7px">
                    <iframe style="pointer-events: none" sandbox=allow-scripts
                        scrolling=no loading=lazy
                        src="${ordinalsExplorerUrl}/preview/${collection.inscription_icon?.replaceAll('"', '')}"></iframe>
                </div>
            </div>`
        collectionsContainer.appendChild(collectionElement)
    }
}

function searchCollections(searchTerm) {
    displayCollections(window.allCollections.filter(x => x.name.toLowerCase().includes(searchTerm.toLowerCase())).slice(0, 12))
}

async function loadCollections(limit, featuredCollections = []) {
    try {
        window.allCollections = await getCollections()

        let displayedCollections = allCollections.slice(0, limit || 999999)
        displayedCollections = featuredCollections.concat(displayedCollections.slice(featuredCollections.length))
            .sort((a, b) => 0.5 - Math.random())


        displayCollections(displayedCollections)
    } catch (e) {
        console.error(e)
        console.error(`Error fetching collections:\n` + e.message)
    }
}

async function loadLatestOrders(limit = 8, nostrLimit = 25) {
    try {
        const orders = getLatestOrders(limit, nostrLimit)

        const ordersContainer = document.getElementById('ordersContainer')
        ordersContainer.innerHTML = ''

        for await (const order of orders) {
            const orderElement = document.createElement('a')
            orderElement.href = `/inscription.html?number=${order.inscriptionId}`
            orderElement.target = `_blank`
            orderElement.innerHTML = `
                <div class="card card-tertiary w-100 fmxw-300">
                    <div class="card-header text-center">
                        <span>Inscription #${order.number}</span>
                    </div>
                    <div class="card-body" style="padding: 6px 7px 7px 7px">
                        <iframe style="pointer-events: none" sandbox=allow-scripts
                            scrolling=no loading=lazy
                            src="${ordinalsExplorerUrl}/preview/${order.inscriptionId}"></iframe>
                        <button class="btn btn-block btn-primary mt-2" style="max-width:185px; max-height: revert">${sanitizeHTML(order.title)}</button>
                    </div>
                </div>`
            ordersContainer.appendChild(orderElement)
        }
    } catch (e) {
        console.error(e)
        console.error(`Error fetching orders:\n` + e.message)
    }
}

async function homePage() {
    loadCollections(12, [{
        "name": "<1k",
        "inscription_icon": "26482871f33f1051f450f2da9af275794c0b5f1c61ebf35e4467fb42c2813403i0",
        "slug": "under-1k",
    }])

    await bitcoinInitializedPromise
    loadLatestOrders()
}

async function collectionsPage() {
    await bitcoinInitializedPromise
    loadCollections()
}

async function listingsPage() {
    await bitcoinInitializedPromise
    loadLatestOrders(100, 200)
}

main()

const currDate = new Date()
const hoursMin = currDate.getHours().toString().padStart(2, '0') + ':' + currDate.getMinutes().toString().padStart(2, '0')
document.getElementById('time').textContent = hoursMin

if (!isProduction) {
    document.getElementById('networkName').textContent = '(Signet)'
}