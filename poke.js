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
  entryPoint,
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

    dns.resolve("api.homegames.io", "A", (err, hosts) => {
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
  indexPath,
  codeDir,
  squishVersion,
) =>
  new Promise((resolve, reject) => {
    console.log("i am poking code");
    console.log(indexPath);
    checkIndex('/thangs/test_unzipped/' + indexPath.path)
      .then((entryPoint) => {
        console.log('entry point');
        console.log(entryPoint);
        homegamesPoke(
          entryPoint,
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

console.log('want me to get thing');
console.log(process.argv[2]);
const codePath = '/thangs/test.zip';//process.argv[2];

const dirPath = '/thangs/test_unzipped';
decompress(codePath, dirPath).then((files) => {
    console.log("HER ARE FILES from " + codePath + " to " + dirPath);
    console.log(files);
    const foundIndex = files.filter(f => f.type === 'file' && f.path.endsWith('index.js'))[0];
    const squishVersion = parseSquishVersion(path.join(dirPath, foundIndex.path));

    pokeCode(foundIndex, dirPath, squishVersion)
  .then(() => {
    console.log("just poked!!! updated");
    writeExitMessage("success");
    process.exit(0);
  })
  .catch((err) => {
    console.log("errororor");
    console.log(err);
    writeExitMessage("ayylmao456");
  });
});
