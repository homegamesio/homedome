const aws = require("aws-sdk");
const { exec } = require("child_process");
const dns = require("dns");
const fs = require("fs");
const path = require('path');
const https = require("https");
const decompress = require('decompress');
const archiver = require("archiver");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const zlib = require("zlib");
const { parseOutput } = require("./strace-parser");

const { Parser } = require('acorn');

const parseSquishVersion = (codePath) => {
    const parsed = Parser.parse(fs.readFileSync(codePath));
    
    const foundGameClasses = parsed.body.filter(n => n.type === 'ClassDeclaration' && n.superClass?.name === 'Game');
    
    if (foundGameClasses.length !== 1) {
        throw new Error('Top-level file should have one defined game class');
    }
    
    const foundGame = foundGameClasses[0];
    
    const foundConstructors = foundGame.body.body.filter(n => n.key?.name === 'metadata' && n.kind === 'method');
    
    if (foundConstructors.length !== 1) {
        throw new Error('Game needs one constructor');
    }
    
    const foundConstructor = foundConstructors[0];
    
    let foundSquishVersion;
    
    foundConstructor.value.body.body.forEach(n => {
        const squishVersionNodes = n.argument.properties.filter(n => n.key?.name === 'squishVersion');
        if (squishVersionNodes.length > 1 || (foundSquishVersion && squishVersionNodes.length == 1)) {
            throw new Error('Multiple squish versions found');
        } 
    
        if (squishVersionNodes.length === 1) {
            foundSquishVersion = squishVersionNodes[0].value.value;
        }
    });
    
    if (!foundSquishVersion) {
        throw new Error('No squish version found');
    }
    
    return foundSquishVersion;
};

const downloadZip = (url) =>
  new Promise((resolve, reject) => {
    const outDir = `/tmp/${Date.now()}`;
    fs.mkdirSync(outDir);
    const zipPath = `${outDir}/data.zip`;
    const dirPath = `${outDir}/data`;

    const zipWriteStream = fs.createWriteStream(zipPath);

    zipWriteStream.on('close', () => {
	console.log('closed thing');
	decompress(zipPath, dirPath).then((files) => {
		console.log('dsfkjdsfjdhsf');
		console.log(files);
		const foundIndex = files.filter(f => f.type === 'file' && f.path.endsWith('index.js'))[0];
		resolve({
			path: path.join(dirPath, foundIndex.path),
			zipPath
		});
	});
//        fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: dirPath }).on('close', () => {
//            const stuff = fs.readdirSync(dirPath);
//            resolve({
//                path: path.join(dirPath, stuff[0]),
//                zipPath: zipPath
//            });
//        }));
    });

    https.get(url, (res) => {
	res.pipe(zipWriteStream);
	zipWriteStream.on('finish', () => {
		zipWriteStream.close();
	});
    }).on('error', (err) => {
        console.error(err);
        reject(err);
    });
  });

const checkIndex = (path) =>
  new Promise((resolve, reject) => {
    fs.access(`${path}`, fs.F_OK, (err) => {
      if (err) {
        reject();
      } else {
        resolve(path);
      }
    });
  });

const homegamesPoke = (
  publishRequest,
  entryPoint,
  gameId,
  sourceInfoHash,
  squishVersion,
) =>
  new Promise((resolve, reject) => {
    const cmd =
      "strace node tester " +
      entryPoint +
      " " +
      require.resolve("squish-" + squishVersion);

    console.log("running command");
    console.log(cmd);

    dns.resolve("landlord.homegames.io", "A", (err, hosts) => {
      const whitelistedIps = hosts;
      let failed = false;
      const listeners = {
        socket: (line) => {
          console.log("doing something with a socket at: " + line);
        },
        connect: (line) => {
          const ipRegex = new RegExp('inet_addr\\("(\\S*)"', "g");
          const _match = ipRegex.exec(line);
          if (_match) {
            const requestedIp = _match[1];
            if (whitelistedIps.indexOf(requestedIp) < 0) {
              emitEvent(
                publishRequest.requestId,
                EVENT_TYPE.FAILURE,
                `Made network request to unknown IP: ${requestedIp}`,
              );
              failed = true;
            }
          }
        },
        open: (line) => {
          //				console.log('not sure what to do here yet: ' + line);
        },
        read: (line) => {
          //				console.log('not sure what to do here yet: ' + line);
        },
      };
      try {
        exec(cmd, { maxBuffer: 1024 * 10000 }, (err, stdout, straceOutput) => {
          parseOutput(straceOutput, listeners);

          console.log(stdout);
          if (failed || err) {
            console.error("failed");
            console.error(err);
            reject("Runtime error");
          } else {
            resolve();
          }
        });
      } catch (err) {
        console.log("is this where it fails");
        console.log(err);
      }
    });
  });

const pokeCode = (
  publishRequest,
  codePath,
  gameId,
  sourceInfoHash,
  squishVersion,
) =>
  new Promise((resolve, reject) => {
    console.log("i am poking code");
    checkIndex(codePath.path)
      .then((entryPoint) => {
        homegamesPoke(
          publishRequest,
          entryPoint,
          gameId,
          sourceInfoHash,
          squishVersion,
        )
          .then(() => {
            resolve();
          })
          .catch((err) => {
            console.log("Failed homegames poke");
            console.log(err);
            reject();
          });
      })
      .catch(() => {
        reject();
      });
  });

console.log("about to do this with");
console.log(process.argv[2]);

const writeExitMessage = (msg) => {
  console.log(
    "AYYYYYYYYYLMAOTHISISTHEEXITMESSAGE:" +
      msg +
      "::andthatwastheendofthemessage",
  );
};

downloadZip(process.argv[2])
  .then((codePath) => {
    const publishEventBase64 = process.argv[3];
    const requestRecordBase64 = process.argv[4];

    const publishEvent = JSON.parse(Buffer.from(publishEventBase64, "base64"));
    const requestRecord = JSON.parse(
      Buffer.from(requestRecordBase64, "base64"),
    );

    const { gameId, sourceInfoHash } = publishEvent;
    const squishVersion = parseSquishVersion(codePath.path);

    pokeCode(publishEvent, codePath, gameId, sourceInfoHash, squishVersion)
      .then(() => {
        console.log("just poked!!!");
        writeExitMessage("success");
      })
      .catch((err) => {
        console.log("errororor");
        console.log(err);
        writeExitMessage("ayylmao456");
      });
  })
  .catch((err) => {
    console.log("eroeroerer");
    console.log(err);
  });
