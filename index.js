const aws = require("aws-sdk");
const { exec } = require("child_process");
const dns = require("dns");
const fs = require("fs");
const path = require('path');
const decompress = require('decompress');
const https = require("https");
const archiver = require("archiver");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const zlib = require("zlib");

const REQUEST_QUEUE_URL = process.env.QUEUE_URL;

const params = {
  QueueUrl: REQUEST_QUEUE_URL,
  MaxNumberOfMessages: 1,
  VisibilityTimeout: 60,
};
const getMongoCollection = (collectionName) => new Promise((resolve, reject) => {
    const { MongoClient } = require('mongodb');
    const uri = 'mongodb://localhost:27017/homegames';
    const client = new MongoClient(uri);
    client.connect().then(() => {
        const db = client.db('homegames');
        const collection = db.collection(collectionName);
        resolve(collection);
    });
});



const sendVerificationEmail = (
  emailAddress,
  code,
  requestId,
  requester,
  repoName,
  commitHash,
) =>
  new Promise((resolve, reject) => {
    const ses = new aws.SES({ region: "us-west-2" });
    const params = {
      Destination: {
        ToAddresses: [emailAddress],
      },
      Message: {
        Body: {
          Html: {
            Charset: "UTF-8",
            Data: `<html><body>Homegames user ${requester} has submitted a game publishing request based on commit ${commitHash} of your GitHub repository ${repoName}.<br /><br />To approve this request, please click <a href="https://api.homegames.io/verify_publish_request?code=${code}&requestId=${requestId}">here</a>.<br /><br />Send an email to support@homegames.io if you need any assistance.</body></html>`,
          },
        },
        Subject: {
          Charset: "UTF-8",
          Data: "Homegames Publishing Request",
        },
      },
      Source: "support@homegames.io",
    };
    ses.sendEmail(params, (err, data) => {
      err ? reject(err) : resolve(data);
    });
  });

const updatePublishRequestState = (gameId, sourceInfoHash, newStatus) =>
  new Promise((resolve, reject) => {
    const ddb = new aws.DynamoDB({
      region: "us-west-2",
    });

    const updateParams = {
      TableName: "publish_requests",
      Key: {
        game_id: {
          S: gameId,
        },
        source_info_hash: {
          S: sourceInfoHash,
        },
      },
      AttributeUpdates: {
        status: {
          Action: "PUT",
          Value: {
            S: newStatus,
          },
        },
      },
    };

    ddb.updateItem(updateParams, (err, putResult) => {
      console.log(err);
      if (err) {
        reject();
      } else {
        resolve();
      }
    });
  });

const getPublishRequestRecord = (gameId, sourceInfoHash) =>
  new Promise((resolve, reject) => {
    const client = new aws.DynamoDB({
      region: "us-west-2",
    });

    const params = {
      TableName: "publish_requests",
      Key: {
        game_id: {
          S: gameId,
        },
        source_info_hash: {
          S: sourceInfoHash,
        },
      },
    };

    client.getItem(params, (err, result) => {
      if (err) {
        reject(err.toString());
      } else {
        if (result.Item) {
          const _item = result.Item;
          console.log("item");
          console.log(_item);
          resolve({
            requestId: _item.request_id.S,
            repoOwner: _item.repo_owner.S,
            created: _item.created.N,
            repoName: _item.repo_name.S,
            requester: _item.requester.S,
            status: _item.status.S,
            gameId: _item.game_id.S,
            commitHash: _item.commit_hash.S
          });
        } else {
          reject("No results");
        }
      }
    });
  });

const getPublishRequest = (requestId) => new Promise((resolve, reject) => {
    getMongoCollection('publishRequests').then((collection) => {
        collection.findOne({ requestId }).then(publishRequest => {
            console.log("PUBLISH REQUEST");
            console.log(publishRequest);
            resolve({
                userId: publishRequest.userId,
                assetId: publishRequest.assetId,
                gameId: publishRequest.gameId,
                requestId: publishRequest.requestId,
                'status': publishRequest['status']
            });
        });
    });
});

const EVENT_TYPE = {
  DOWNLOAD: "DOWNLOAD",
  POKE: "POKE",
  VERIFY: "VERIFY",
  PUBLISH: "PUBLISH",
  FAILURE: "FAILURE",
  SUCCESS: "SUCCESS",
  ERROR: "ERROR",
};

const REQUEST_STATUS = {
  SUBMITTED: "SUBMITTED",
  PROCESSING: "PROCESSING",
  FAILED: "FAILED",
  PENDING_CONFIRMATION: "PENDING_CONFIRMATION",
  APPROVED: "APPROVED",
  PUBLISHED: "PUBLISHED",
};

const emitEvent = (requestId, eventType, message = null) =>
  new Promise((resolve, reject) => {
    const client = new aws.DynamoDB({
      region: "us-west-2",
    });

    const params = {
      TableName: "publish_events",
      Item: {
        request_id: {
          S: requestId,
        },
        event_date: {
          N: `${Date.now()}`,
        },
        event_type: {
          S: eventType,
        },
      },
    };

    if (message != null) {
      params.Item.message = { S: message };
    }

    client.putItem(params, (err, putResult) => {
      if (!err) {
        resolve();
      } else {
        reject(err);
      }
    });
  });

const getGameInstance = (owner, repo, commit) =>
  new Promise((resolve, reject) => {
    getCommit(owner, repo, commit).then((_res) => {
      getBuild(owner, repo, commit).then((dir) => {
        const cmd = ["--prefix", dir.path, "install"];
        const { exec } = require("child_process");
        exec("npm --prefix " + dir.path + " install", (err, stdout, stderr) => {
          const _game = require(dir.path);
          resolve(_game);
        });
      });
    });
  });

const getBuildBase64 = (owner, repo, commit = undefined) =>
  new Promise((resolve, reject) => {
    const commitString = commit ? "/" + commit : "";
    const thing = `https://codeload.github.com/${owner}/${repo}/zip${commitString}`;
    https.get(thing, (_response) => {
      let buf = Buffer.from([]);
      _response.on("data", (data) => {
        const newTotal = Buffer.concat([buf, data]);
        buf = newTotal;
      });

      _response.on("end", () => {
        resolve(buf.toString("base64"));
      });
    });
  });

// copied from poke
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



const getBuild = (owner, repo, commit = undefined) =>
  new Promise((resolve, reject) => {
    const commitString = commit ? "/" + commit : "";
    const thing = `https://codeload.github.com/${owner}/${repo}/zip${commitString}`;
    downloadZip(thing).then(resolve);
  });

const getCommit = (owner, repo, commit = undefined) =>
  new Promise((resolve, reject) => {
    const _headers = {
      "User-Agent": "HomegamesLandlord/0.1.0",
    };

    https.get(
      {
        hostname: "api.github.com",
        path: `/repos/${owner}/${repo}${commit ? "/" + commit : ""}`,
        headers: _headers,
      },
      (res) => {
        let _buf = "";

        res.on("end", () => {
          resolve(_buf);
        });

        res.on("data", (_data) => {
          _buf += _data;
        });
      },
    );
  });

const getS3Url = (gameId, requestId) => {
  return `https://hg-games.s3-us-west-2.amazonaws.com/${gameId}/${requestId}/code.zip`;
};

const uploadZip = (zipPath, gameId, requestId) =>
  new Promise((resolve, reject) => {
    const s3 = new aws.S3({ region: "us-west-2" });
    const zipData = fs.readFileSync(zipPath);
    const params = {
      Body: zipData,
      ACL: "public-read",
      Bucket: "hg-games",
      Key: `${gameId}/${requestId}/code.zip`,
    };

    s3.putObject(params, (s3Err, s3Data) => {
      console.log("put object result");
      console.log(s3Err);
      console.log(s3Data);
      if (s3Err) {
        console.log(`s3 error ${s3Err}`);
        reject();
      } else {
        resolve();
      }
    });
  });

const checkIndex = (directory) =>
  new Promise((resolve, reject) => {
    fs.access(`${directory}/index.js`, fs.F_OK, (err) => {
      if (err) {
        reject();
      } else {
        resolve(`${directory}/index.js`);
      }
    });
  });

const homegameCheck = (entryPointPath) =>
  new Promise((resolve, reject) => {
    console.log("i am verifying homegames code. dont know what that means yet");
    resolve();
  });

const createCode = (publishRequestId) =>
  new Promise((resolve, reject) => {
    const code = getHash(uuidv4());

    const client = new aws.DynamoDB({ region: "us-west-2" });

    const params = {
      TableName: "verification_requests",
      Item: {
        publish_request_id: { S: publishRequestId },
        code: { S: code },
      },
    };

    client.putItem(params, (err, putResult) => {
      if (err) {
        reject();
      } else {
        resolve(code);
      }
    });
  });

const getHash = (input) => {
  return crypto.createHash("md5").update(input).digest("hex");
};

const sendVerifyRequest = (publishRequest) =>
  new Promise((resolve, reject) => {
    emitEvent(
      publishRequest.requestId,
      EVENT_TYPE.VERIFY,
      "Sent approval email to repo owner",
    );
    getOwnerEmail(publishRequest.repoOwner).then((email) => {
      createCode(publishRequest.requestId).then((code) => {
        sendVerificationEmail(
          email,
          code,
          publishRequest.requestId,
          publishRequest.requester,
          publishRequest.repoName,
          publishRequest.commitHash,
        ).then(() => {
          resolve();
        });
      });
    });
  });

const getOwnerEmail = (owner) =>
  new Promise((resolve, reject) => {
    const _headers = {
      "User-Agent": "HomegamesLandlord/0.1.0",
      Authorization:
        "Basic " +
        Buffer.from(`${GITHUB_USER}:${GITHUB_KEY}`).toString("base64"),
    };

    https.get(
      {
        hostname: "api.github.com",
        path: `/users/${owner}`,
        headers: _headers,
      },
      (res) => {
        let _buf = "";

        res.on("end", () => {
          const data = JSON.parse(_buf);
          resolve(data.email);
        });

        res.on("data", (_data) => {
          _buf += _data;
        });
      },
    );
  });

const verifyGithubInfo = (requestRecord) =>
  new Promise((resolve, reject) => {
    console.log("need to verify info from here for api");
    console.log(requestRecord);
    const _headers = {
      "User-Agent": "HomegamesLandlord/0.1.0",
    };

    const req = https.request(
      {
        hostname: "api.github.com",
        path: `/repos/${requestRecord.repoOwner}/${requestRecord.repoName}`, //${requestRecord.commitHash ? '/' + requestRecord.commitHash : ''}`,
        headers: _headers,
        method: "GET",
      },
      (res) => {
        let _buf = "";

        res.on("end", () => {
          console.log("got buf");
          console.log(_buf);
          const jsonRes = JSON.parse(_buf);
          const licenseKey = jsonRes.license && jsonRes.license.key;
          if (!licenseKey || licenseKey !== "gpl-3.0") {
            console.log("bad license" + licenseKey);
            reject("Bad license " + licenseKey);
          } else {
            resolve(_buf);
          }
        });

        res.on("data", (_data) => {
          _buf += _data;
        });
      },
    );

    req.on("error", (e) => {
      console.log(e);
    });

    req.end();
  });

const dockerPoke = (publishEvent, requestRecord) => new Promise((resolve, reject) => {
    console.log('need to run dockerr thing');
    const { exec } = require("child_process");
    const cmd = `docker run --rm tang2 ${requestRecord.assetId} ${Buffer.from(JSON.stringify(publishEvent)).toString('base64url')} ${Buffer.from(JSON.stringify(requestRecord)).toString('base64url')}`;
    console.log(cmd);
    const ting = exec(cmd, (err, stderr, stdout) => {
        console.log('eeoeoeoe');
        console.log(err);
        console.log(stderr);
        console.log(stdout);
        const lines = stderr && stderr.split("\\n");
        let exitMessage = null;
        if (lines) {
          for (line in lines) {
            const ting = stderr.match(
              "AYYYYYYYYYLMAOTHISISTHEEXITMESSAGE:(.+)::andthatwastheendofthemessage",
            );
            if (ting) {
              console.log("TING!!!!");
              console.log(ting);
              if (ting[1]) {
                if (exitMessage) {
                  console.error("Multiple exit messages found");
                  throw new Error("nope nope nope multiple exit messages");
                }
                exitMessage = ting[1];
                if (exitMessage.startsWith("success")) {
                    const squishVersion = exitMessage.split('-')[1];
                  // success-<squishVersion>
                  resolve(squishVersion);
                } else {
                  reject("Failed: " + exitMessage);
                }
              }
            }
          }
        } else {
            reject('no output');
        }
    });
});
//  new Promise((resolve, reject) => {
//    let exitMessage = "";
//    const { exec } = require("child_process");
//    console.log(
//      "docker run --rm tang " +
//        gamePath +
//        " " +
//        Buffer.from(JSON.stringify(publishEvent)).toString("base64") +
//        " " +
//        Buffer.from(JSON.stringify(requestRecord)).toString("base64"),
//    );
//    const ting = exec(
//      "docker run --rm tang " +
//        gamePath +
//        " " +
//        Buffer.from(JSON.stringify(publishEvent)).toString("base64") +
//        " " +
//        Buffer.from(JSON.stringify(requestRecord)).toString("base64"),
//      (err, stderr, stdout) => {
//        const lines = stderr && stderr.split("\\n");
//        let exitMessage = null;
//        if (lines) {
//          for (line in lines) {
//            const ting = stderr.match(
//              "AYYYYYYYYYLMAOTHISISTHEEXITMESSAGE:(.+)::andthatwastheendofthemessage",
//            );
//            if (ting) {
//              console.log("TING!!!!");
//              console.log(ting);
//              if (ting[1]) {
//                if (exitMessage) {
//                  console.error("Multiple exit messages found");
//                  throw new Error("nope nope nope multiple exit messages");
//                }
//                exitMessage = ting[1];
//                if (exitMessage === "success") {
//                  resolve();
//                } else {
//                  reject("Failed: " + exitMessage);
//                }
//              }
//            }
//          }
//        }
//        console.log("EXIT MESAGE");
//        console.log(exitMessage);
//      },
//    );
//  });

const generateId = () => getHash(uuidv4());

const publishVersion = (squishVersion, publishEvent, requestRecord) => new Promise((resolve, reject) => {
    console.log('papapapa publishing');
    console.log(publishEvent);
    console.log(requestRecord);
    getMongoCollection('gameVersions').then(collection => {
        const gameVersion = { squishVersion, gameId: requestRecord.gameId, versionId: generateId(), requestId: requestRecord.requestId, publishedAt: Date.now(), publishedBy: requestRecord.userId, sourceAssetId: requestRecord.assetId };
        collection.insertOne(gameVersion).then(() => {
            console.log('created version');
            resolve(gameVersion);
        });
    });
});

const handlePublishEvent = (publishEvent) =>
  new Promise((resolve, reject) => {
    const { requestId, gameId, userId, assetId } = publishEvent;
    console.log(publishEvent);
    if (requestId) {
        getPublishRequest(requestId).then(requestRecord => {
            console.log("got publisshds");
            dockerPoke(publishEvent, requestRecord).then((squishVersion) => {
                console.log('docker poked');
                publishVersion(squishVersion, publishEvent, requestRecord).then(resolve).catch(reject);
            });
        });
    }
    console.log(gameId);
    //updatePublishRequestState(
    //  gameId,
    //  sourceInfoHash,
    //  REQUEST_STATUS.PROCESSING,
    //).then(() => {
    //  getPublishRequestRecord(gameId, sourceInfoHash).then((requestRecord) => {
    //    verifyGithubInfo(requestRecord)
    //      .then((blahGarbage) => {
    //        const {
    //          repoOwner: owner,
    //          repoName: repo,
    //          commitHash: commit,
    //        } = requestRecord; 
    //        const commitString = commit ? "/" + commit : "";
    //        const thing = `https://codeload.github.com/${owner}/${repo}/zip${commitString}`;

    //        dockerPoke(thing, publishEvent, requestRecord).then(() => {
    //          homegameCheck()
    //            .then(() => {
    //              getBuild(owner, repo, commit).then((pathInfo) => {
    //                emitEvent(requestRecord.requestId, "UPLOAD_ZIP");

    //                uploadZip(pathInfo.zipPath, gameId, requestRecord.requestId)
    //                  .then(() => {
    //                    console.log(
    //                      "uploaded zip for request " + requestRecord.requestId,
    //                    );
    //                    sendVerifyRequest(requestRecord).then(() => {
    //                      updatePublishRequestState(
    //                        gameId,
    //                        sourceInfoHash,
    //                        REQUEST_STATUS.PENDING_CONFIRMATION,
    //                      );
    //                    });
    //                  })
    //                  .catch((err) => {
    //                    console.log("failed to upload zip");
    //                    console.log(err);
    //                    reject();
    //                  });
    //              });
    //            })
    //            .catch((err) => {
    //              console.error("failed homegames check");
    //              console.log(err);
    //              emitEvent(
    //                requestRecord.requestId,
    //                EVENT_TYPE.FAILURE,
    //                `Encountered error: ${err}`,
    //              );
    //              updatePublishRequestState(
    //                gameId,
    //                sourceInfoHash,
    //                REQUEST_STATUS.FAILED,
    //              );
    //            });
    //        });
    //      })
    //      .catch((err) => {
    //        console.error("Failed verifying github info");
    //        console.error(err);
    //        emitEvent(
    //          requestRecord.requestId,
    //          EVENT_TYPE.FAILURE,
    //          `Encountered error: ${err}`,
    //        );
    //        updatePublishRequestState(
    //          gameId,
    //          sourceInfoHash,
    //          REQUEST_STATUS.FAILED,
    //        );
    //      });
    //  });
    //});
  });

setInterval(() => {
    const amqp = require('amqplib/callback_api');
    amqp.connect('amqp://localhost', (err, conn) => {
        conn.createChannel((err1, channel) => {
            channel.assertQueue('publish_requests', {
                durable: false
            });
            
            channel.consume('publish_requests', (msg) => {
                const request = JSON.parse(msg.content);
                handlePublishEvent(request);
            }, {
                noAck: true
            });
        });
    });
}, 1 * 1000);

