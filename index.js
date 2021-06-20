const archiver = require('archiver');
const https = require('https');
const fs = require('fs');
const unzipper = require('unzipper');

console.log('i need to get some code that you give me');

const url = `https://codeload.github.com/prosif/do-dad/zip/c3ed3c1030d74a9330974b1d161b0d1d04c687d8`;

console.log('is it a valid url?');
const isValid = url.startsWith('https://codeload.github.com') && new URL(url);

console.log('is it code?');
    
    const dir = `games/${Date.now()}`;

    const file = fs.createWriteStream(dir + '.zip');
    const zlib = require('zlib');
    const thing = url;
    const archive = archiver('zip');
    const output = fs.createWriteStream(dir + 'out.zip');

    https.get(thing, (_response) => {
        output.on('close', () => {
            fs.readdir(dir, (err, files) => {
                console.log("okay!");
                ting = {
                    path: dir + '/' + files[0],
                    zipPath: dir + 'out.zip'
                };

                console.log(ting);
                console.log('is it javascript?');

                try {
                    const sourceNodeModules = '/Users/josephgarcia/homegames/homedome/node_modules';
                    fs.symlink(sourceNodeModules, ting.path + '/node_modules', 'dir', (err) => {
                        console.log("DSFDSFDSF");
                        console.log(err);
                        const gameIndex = require(ting.path);
                        console.log("GAME INDEXXX");
                        console.log(gameIndex);
                    });
                } catch (err) {
                    console.log("ERRRRR");
                    console.log(err);
                }
                console.log('is it less than 50mb?');
                console.log('is it compatible with homegames?');
                console.log('does it make network requests?');
                console.log('does it access the filesystem?');
                console.log('does it have a render function?');
                console.log('does it have some sort of state and does it update it? (maybe not needed)');
            });
        });

        const stream = _response.pipe(unzipper.Extract({
            path: dir
        }));

        stream.on('finish', () => {
            archive.directory(dir, false);
            archive.finalize();
        });

        archive.pipe(output);
    });
 

