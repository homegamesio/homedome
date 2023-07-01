const aws = require('aws-sdk');
const { exec } = require('child_process');
const dns = require('dns');
const fs = require('fs');
const https = require('https');
const unzipper = require('unzipper');
const archiver = require('archiver');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const zlib = require('zlib');
const { parseOutput } = require('./strace-parser');

const downloadZip = (url) => new Promise((resolve, reject) => {
    console.log('the fuckeroo');
    const dir = `/tmp/${Date.now()}`;

    const file = fs.createWriteStream(dir + '.zip');
    const archive = archiver('zip');
    const output = fs.createWriteStream(dir + 'out.zip');
    console.log('the fuckero2');
	console.log(url);

    https.get(url, (_response) => {
	console.log("GOT RESPONSE!");
        output.on('close', () => {
		console.log("CLOSED");
            fs.readdir(dir, (err, files) => {
		console.log("WHEN I READ FILES I GETG");
		console.log(files)
                resolve({
                    path: dir + '/' + files[0],
                    zipPath: dir + 'out.zip'
                });
            });
        });

        const stream = _response.pipe(unzipper.Extract({
            path: dir
        }));

		console.log("CLOSED dsfdsfds");
	stream.on('end', () => {console.log('wtffffe end?')})
	stream.on('close', () => {
		console.log("CLOSED stream");
                fs.readdir(dir, (err, files) => {
//			setTimeout(() => {
		const projectRoot = `${dir}/${files[0]}`;
console.log(projectRoot);
            archive.file(projectRoot + '/index.js', { name: 'index.js' } );//, false);
//            archive.file(projectRoot + '/src/layer-base.js');//, false);
            archive.directory(projectRoot + '/src', 'src');
            archive.finalize().then(() => {
			console.log('finalized plesase');
      fs.readdir(dir, (err, files) => {
		console.log("WHEN I READ FILES I GETG");
		console.log(files)
                resolve({
                    path: dir + '/' + files[0],
                    zipPath: dir + 'out.zip'
                });
            });

	    });
		})	
	})
});
});

const checkIndex = (directory) => new Promise((resolve, reject) => {
	fs.access(`${directory}/index.js`, fs.F_OK, (err) => {
		if (err) {
			reject();
		} else {
			resolve(`${directory}/index.js`);
		}
	});
});

const homegamesPoke = (publishRequest, entryPoint, gameId, sourceInfoHash, squishVersion) => new Promise((resolve, reject) => {
	const cmd = 'strace node tester ' + entryPoint + ' ' + squishVersion;

	console.log('running command');
	console.log(cmd);

	dns.resolve('landlord.homegames.io', 'A', (err, hosts) => {
		const whitelistedIps = hosts;
		let failed = false;
		const listeners = {
			'socket': (line) => {
				console.log('doing something with a socket at: ' + line);
			},
			'connect': (line) => {
				const ipRegex = new RegExp('inet_addr\\(\"(\\S*)\"', 'g');
				const _match = ipRegex.exec(line);
				if (_match) {
					const requestedIp = _match[1];
					if (whitelistedIps.indexOf(requestedIp) < 0) {
						emitEvent(publishRequest.requestId, EVENT_TYPE.FAILURE, `Made network request to unknown IP: ${requestedIp}`);
						failed = true;
					}
					
				}	
			},
			'open': (line) => {
//				console.log('not sure what to do here yet: ' + line);
			},
			'read': (line) => {
//				console.log('not sure what to do here yet: ' + line);
			}
		};
		try {
			exec(cmd, {maxBuffer: 1024 * 10000}, (err, stdout, straceOutput) => {
				parseOutput(straceOutput, listeners);

				console.log(stdout);
				if (failed || err) {
					console.error('failed');
					console.error(err);
					reject('Runtime error');
				} else {
					resolve();
				}
			});	
		} catch (err) {
			console.log('is this where it fails');
			console.log(err);
		}
	});
});

const pokeCode = (publishRequest, codePath, gameId, sourceInfoHash, squishVersion) => new Promise((resolve, reject) => {
	console.log('i am poking code');
	checkIndex(codePath.path).then(entryPoint => {
		homegamesPoke(publishRequest, entryPoint, gameId, sourceInfoHash, squishVersion).then(() => {
			resolve();
		}).catch(err => {
			console.log("Failed homegames poke");
			console.log(err);
			reject();
		});
	}).catch(() => {
		reject();
	});
});

console.log('about to do this with');
console.log(process.argv[2]);

const writeExitMessage = (msg) => {
	console.log("AYYYYYYYYYLMAOTHISISTHEEXITMESSAGE:" + msg + "::andthatwastheendofthemessage");
};

downloadZip(process.argv[2]).then((codePath) => {
	console.log('downloaded holy shit');
	console.log("CODE PATH");
	console.log(codePath);
	const publishEventBase64 = process.argv[3];
	const requestRecordBase64 = process.argv[4];

	const publishEvent = JSON.parse(Buffer.from(publishEventBase64, "base64"));
	const requestRecord = JSON.parse(Buffer.from(requestRecordBase64, "base64"));
	
	const { gameId, sourceInfoHash, squishVersion } = publishEvent;
	pokeCode(publishEvent, codePath, gameId, sourceInfoHash, squishVersion).then(() => {
		console.log('just poked!!!');
		writeExitMessage('ayylmao123');
	}).catch(err => {
		console.log('errororor');
		console.log(err);
		writeExitMessage('ayylmao456');
	});
}).catch(err => {
	console.log('eroeroerer');
	console.log(err);
});

//while (true) {

//}
