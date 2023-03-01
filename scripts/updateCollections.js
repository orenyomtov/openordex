const { writeFileSync } = require('fs');
const fetch = require('node-fetch')

async function main() {
    const collections = []
    const collectionsRepoFiles = await fetch('https://api.github.com/repos/ordinals-wallet/ordinals-collections/git/trees/HEAD?per_page=1&recursive=1')
        .then(r => r.json())
    const collectionSlugs = collectionsRepoFiles.tree.map(t => t.path.match(/collections\/(.*?)\/meta.json/)?.[1]).filter(path => path)

    console.log(`Found ${collectionSlugs.length} collections`)

    let counter = 0
    for (const slug of collectionSlugs) {
        console.log(`${++counter}/${collectionSlugs.length} - ${slug}`)
        const collection = await fetch(`https://raw.githubusercontent.com/ordinals-wallet/ordinals-collections/main/collections/${slug}/meta.json`)
            .then(r => r.json())

        collections.push(collection)
    }

    console.log(`Writing collections.json`)
    writeFileSync('../static/collections.json', JSON.stringify(collections, undefined, 2));
    console.log('Done!')
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
