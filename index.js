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

const GITHUB_USER = '';
const GITHUB_KEY = '';
const REQUEST_QUEUE_URL = '';

const params = {
	QueueUrl: REQUEST_QUEUE_URL,
	MaxNumberOfMessages: 1,
	VisibilityTimeout: 60
};

const sendVerificationEmail = (emailAddress, code, requestId, requester, repoName, commitHash) => new Promise((resolve, reject) => {
	const ses = new aws.SES({region: 'us-west-2'});
        const params = {
            Destination: {
                ToAddresses: [
                	emailAddress 
                ]
            },
            Message: {
                Body: {
                    Html: {
                        Charset: 'UTF-8',
                        Data: `<html><body>Homegames user ${requester} has submitted a game publishing request based on commit ${commitHash} of your GitHub repository ${repoName}.<br /><br />To approve this request, please click <a href="https://api.homegames.io/verify_publish_request?code=${code}&requestId=${requestId}">here</a>.<br /><br />Send an email to support@homegames.io if you need any assistance.</body></html>`
                    }   
                },
                Subject: {
                    Charset: 'UTF-8',
                    Data: 'Homegames Publishing Request'
                }
            },
            Source: 'support@homegames.io'
        };
        ses.sendEmail(params, (err, data) => {
            err ? reject(err) : resolve(data);
        });
});

const { parseOutput } = require('./strace-parser');

const updatePublishRequestState = (gameId, sourceInfoHash, newStatus) => new Promise((resolve, reject) => {
	const ddb = new aws.DynamoDB({
       		region: 'us-west-2'
        });

        const updateParams = {
            TableName: 'publish_requests',
	    Key: {
                'game_id': {
                    S: gameId
                },
		'source_info_hash': {
		    S: sourceInfoHash
		}
            },
            AttributeUpdates: {
                'status': {
                    Action: 'PUT',
                    Value: {
                        S: newStatus
                    }
                }
            }
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

const getPublishRequestRecord = (gameId, sourceInfoHash) => new Promise((resolve, reject) => {
	const client = new aws.DynamoDB({
            region: 'us-west-2'
        });

        const params = {
            TableName: 'publish_requests',
            Key: {
                'game_id': {
                    S: gameId
                },
		'source_info_hash': {
		    S: sourceInfoHash
		}
            }
        };

        client.getItem(params, (err, result) => {
            if (err) {
                reject(err.toString());
            } else {
                if (result.Item) {
		    const _item = result.Item;
			console.log('item');
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
                    reject('No results');
                }
            }
        });
});

const EVENT_TYPE = {
	DOWNLOAD: "DOWNLOAD",
	POKE: "POKE",
	VERIFY: "VERIFY",
	PUBLISH: "PUBLISH",
	FAILURE: "FAILURE",
	SUCCESS: "SUCCESS",
	ERROR: "ERROR"
};

const REQUEST_STATUS = {
	SUBMITTED: "SUBMITTED",
	PROCESSING: "PROCESSING",
	FAILED: "FAILED",
	PENDING_CONFIRMATION: "PENDING_CONFIRMATION",
	APPROVED: "APPROVED",
	PUBLISHED: "PUBLISHED"
};

const emitEvent = (requestId, eventType, message = null) => new Promise((resolve, reject) => {

    const client = new aws.DynamoDB({
        region: 'us-west-2'
    });

    const params = {
        TableName: 'publish_events',
        Item: {
	    'request_id': {
		S: requestId
	    },
	    'event_date': {
                N: `${Date.now()}`
	    },
	    'event_type': {
		S: eventType
	    }
        }
    };

    if (message != null) {
	params.Item.message = {S: message};
    }

    client.putItem(params, (err, putResult) => {
        if (!err) {
            resolve();
        } else {
            reject(err);
        }
    });
});


const getGameInstance = (owner, repo, commit) => new Promise((resolve, reject) => {

    getCommit(owner, repo, commit).then(_res => {

        getBuild(owner, repo, commit).then((dir) => {
            const cmd = ['--prefix', dir.path, 'install'];
            const {
                exec
            } = require('child_process');
            exec('npm --prefix ' + dir.path + ' install', (err, stdout, stderr) => {
                const _game = require(dir.path);
                resolve(_game);
            });
        });

    });

});

const getBuildBase64 = (owner, repo, commit = undefined) => new Promise((resolve, reject) => {
    const commitString = commit ? '/' + commit : '';
    const thing = `https://codeload.github.com/${owner}/${repo}/zip${commitString}`;
    https.get(thing, (_response) => {
	let buf = Buffer.from([]);
	_response.on('data', (data) => {
		console.log('ayy lmao!');
		console.log(data);
		const newTotal = Buffer.concat([buf, data]);
		buf = newTotal;
	});

	_response.on('end', () => {
		console.log('end/??');
		console.log(buf);
		resolve(buf.toString('base64'));
	});
    });
});

const getBuild = (owner, repo, commit = undefined) => new Promise((resolve, reject) => {
    // todo: uuid
    const dir = `/tmp/${Date.now()}`;

    const commitString = commit ? '/' + commit : '';
    const file = fs.createWriteStream(dir + '.zip');
    const thing = `https://codeload.github.com/${owner}/${repo}/zip${commitString}`;
    const archive = archiver('zip');
    const output = fs.createWriteStream(dir + 'out.zip');

	console.log('downloading ' + thing);
	console.log(dir);

    https.get(thing, (_response) => {
        output.on('close', () => {
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

	stream.on('end', () => {console.log('wtffffe end?')})
	stream.on('close', () => {
                fs.readdir(dir, (err, files) => {
//			setTimeout(() => {
		const projectRoot = `${dir}/${files[0]}`;
console.log(projectRoot);
            archive.file(projectRoot + '/index.js', { name: 'index.js' } );//, false);
//            archive.file(projectRoot + '/src/layer-base.js');//, false);
            archive.directory(projectRoot + '/src', 'src');
            archive.finalize();
	})
});

        stream.on('finish', () => {
		console.log('finishedddd');
                fs.readdir(dir, (err, files) => {
//			setTimeout(() => {
//		const projectRoot = `${dir}/${files[0]}`;
//console.log(projectRoot);
//            archive.file(projectRoot + '/index.js');//, false);
//            archive.file(projectRoot + '/src/layer-base.js');//, false);
////            archive.directory(projectRoot + '/src', false);
//            archive.finalize();
//}, 5000);
});
        });

        archive.pipe(output);
    });
});

const getCommit = (owner, repo, commit = undefined) => new Promise((resolve, reject) => {
    const _headers = {
        'User-Agent': 'HomegamesLandlord/0.1.0'
    };

    https.get({
        hostname: 'api.github.com',
        path: `/repos/${owner}/${repo}${commit ? '/' + commit : ''}`,
        headers: _headers
    }, res => {

        let _buf = '';

        res.on('end', () => {
            resolve(_buf);
        });

        res.on('data', (_data) => {
            _buf += _data;
        });

    });
});

const getS3Url = (gameId, requestId) => {
	return `https://hg-games.s3-us-west-2.amazonaws.com/${gameId}/${requestId}/code.zip`;
};

const uploadZip = (zipPath, gameId, requestId) => new Promise((resolve, reject) => {
	const s3 = new aws.S3({region: 'us-west-2'});
	console.log("READING FILE FROMT HIS");
	console.log(zipPath);
	fs.readFile(zipPath, (err, buf) => {
		if (err) {
			console.log(`read file error ${err}`);
			reject();
		} else {
			const params = {
				Body: buf,
				ACL: 'public-read',
				Bucket: 'hg-games',
				Key: `${gameId}/${requestId}/code.zip`
			};

			s3.putObject(params, (s3Err, s3Data) => {
				console.log('put object result');
				console.log(s3Err);
				console.log(s3Data);
				if (s3Err) {
					console.log(`s3 error ${s3Err}`);
					reject();
				} else {
					resolve();
				}
			});
		}
	});
});


const downloadCode = (publishRequest) => new Promise((resolve, reject) => {
	console.log('i am downloading code');
	console.log(publishRequest);
	getBuildBase64(publishRequest.repoOwner, publishRequest.repoName, publishRequest.commitHash).then(resolve);
	//emitEvent(publishRequest.requestId, EVENT_TYPE.DOWNLOAD);
	//getBuild(publishRequest.repoOwner, publishRequest.repoName, publishRequest.commitHash).then((pathInfo) => {
	//	emitEvent(publishRequest.requestId, 'UPLOAD_ZIP');
	//	uploadZip(pathInfo.zipPath, publishRequest.gameId, publishRequest.requestId).then(() => {
	//		console.log('uploaded zip for request ' + publishRequest.requestId);
	//		resolve(pathInfo);
	//	}).catch(err => {
	//		console.log('failed to upload zip');
	//		console.log(err);
	//		reject();
	//	});
	//}).catch(err => {
	//	console.log('get build error ' + err);
	//	reject();
	//});;
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

	dns.resolve('api.homegames.io', 'A', (err, hosts) => {
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
	emitEvent(publishRequest.requestId, EVENT_TYPE.POKE);
	checkIndex(codePath.path).then(entryPoint => {
		homegamesPoke(publishRequest, entryPoint, gameId, sourceInfoHash, squishVersion).then(() => {
			resolve();
		}).catch(err => {
			console.log("Failed homegames poke");
			console.log(err);
			reject();
		});
	}).catch(() => {
		emitEvent(publishRequest.requestId, EVENT_TYPE.FAILURE, 'No index.js found');
		reject();
	});
});

const homegameCheck = (entryPointPath) => new Promise((resolve, reject) => {
	console.log('i am verifying homegames code. dont know what that means yet');
	resolve();
});

const createCode = (publishRequestId) => new Promise((resolve, reject) => {

    const code = getHash(uuidv4());

    const client = new aws.DynamoDB({region: 'us-west-2'});

    const params = {
        TableName: 'verification_requests',
        Item: {
	    'publish_request_id': {S: publishRequestId},
            'code': {S: code}
        }
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
    return crypto.createHash('md5').update(input).digest('hex');
};

const sendVerifyRequest = (publishRequest) => new Promise((resolve, reject) => {
	emitEvent(publishRequest.requestId, EVENT_TYPE.VERIFY, 'Sent approval email to repo owner');
	getOwnerEmail(publishRequest.repoOwner).then((email) => {
		createCode(publishRequest.requestId).then((code) => {
			sendVerificationEmail(email, code, publishRequest.requestId, publishRequest.requester, publishRequest.repoName, publishRequest.commitHash).then(() => {
				resolve();
			});
		});
	});
});

const getOwnerEmail = (owner) => new Promise((resolve, reject) => {
     const _headers = {
        'User-Agent': 'HomegamesLandlord/0.1.0',
        'Authorization': 'Basic ' + Buffer.from(`${GITHUB_USER}:${GITHUB_KEY}`).toString('base64')
    };

    https.get({
        hostname: 'api.github.com',
        path: `/users/${owner}`,
        headers: _headers
    }, res => {
        
        let _buf = '';

        res.on('end', () => {
            const data = JSON.parse(_buf);
            resolve(data.email);
        });

        res.on('data', (_data) => {
            _buf += _data;
        }); 

    });
});

const verifyGithubInfo = (requestRecord) => new Promise((resolve, reject) => {
	console.log('need to verify info from here for api');
	console.log(requestRecord);
    const _headers = {
        'User-Agent': 'HomegamesLandlord/0.1.0'
    };

    const req = https.request({
        hostname: 'api.github.com',
        path: `/repos/${requestRecord.repoOwner}/${requestRecord.repoName}`,//${requestRecord.commitHash ? '/' + requestRecord.commitHash : ''}`,
        headers: _headers,
	method: 'GET'
    }, res => {

        let _buf = '';

        res.on('end', () => {
		console.log("got buf");
		console.log(_buf);
		const jsonRes = JSON.parse(_buf);
		const licenseKey = jsonRes.license && jsonRes.license.key;
		if (!licenseKey || licenseKey !== 'gpl-3.0') {
			console.log('bad license' + licenseKey);
			reject('Bad license ' + licenseKey);
		} else {
	            resolve(_buf);
		}
        });

        res.on('data', (_data) => {
            _buf += _data;
        });

    });

req.on('error', (e) => {
	console.log(e);
});

console.log('ehre ifsdf ' + req.path);

req.end();
});

const dockerPoke = (gamePath, publishEvent, requestRecord) => new Promise((resolve, reject) => {
	console.log('game is at ');
	console.log(gamePath);

//	console.log("AYYYYYYYYYLMAOTHISISTHEEXITMESSAGE:" + msg);
//	console.log("AYYYYYYYYYLMAOTHISISTHEEXITMESSAGE:" + msg + "::andthatwastheendofthemessage");
	let exitMessage = '';
	const {
            exec
        } = require('child_process');
	console.log('dfsgdfjkgdfjkg');
	console.log('docker run --rm tang ' + gamePath + ' ' + Buffer.from(JSON.stringify(publishEvent)).toString('base64') + ' ' + Buffer.from(JSON.stringify(requestRecord)).toString('base64'));
        const ting = exec('docker run --rm tang ' + gamePath + ' ' + Buffer.from(JSON.stringify(publishEvent)).toString('base64') + ' ' + Buffer.from(JSON.stringify(requestRecord)).toString('base64'), (err, stderr, stdout) => {//npm --prefix ' + dir.path + ' install', (err, stdout, stderr) => {
		console.log("DID THAT?");
		console.log(!!err);
		console.log(!!stdout);
		console.log(!!stderr);
		console.log(stdout);

		const lines = stderr && stderr.split('\\n');
		let exitMessage = null;
		if (lines) {
			for (line in lines) {
				const ting = stderr.match("AYYYYYYYYYLMAOTHISISTHEEXITMESSAGE:(.+)::andthatwastheendofthemessage");
				if (ting) {
					console.log("TING!!!!");
					console.log(ting);
					if (ting[1]) {
						if (exitMessage) {
							console.error('Multiple exit messages found');
							throw new Error('nope nope nope multiple exit messages');
						}
						exitMessage = ting[1];
						if (exitMessage === 'success') {
							resolve();
						} else {
							reject('Failed: ' + exitMessage);
						}
					}
					//exitMessage =
				}
			}
		}
		console.log("EXIST MESAGE");
		console.log(exitMessage);
        });
});

const handlePublishEvent = (publishEvent) => new Promise((resolve, reject) => {
  
	const { gameId, sourceInfoHash, squishVersion } = publishEvent;

	updatePublishRequestState(gameId, sourceInfoHash, REQUEST_STATUS.PROCESSING).then(() => {
		getPublishRequestRecord(gameId, sourceInfoHash).then((requestRecord) => {
	            verifyGithubInfo(requestRecord).then(blahGarbage => {
			const { repoOwner: owner, repoName: repo, commitHash: commit } =  requestRecord;//.repoOwner, publishRequest.repoName, publishRequest.commitHash).then(resolve);
		    	const commitString = commit ? '/' + commit : '';
    			const thing = `https://codeload.github.com/${owner}/${repo}/zip${commitString}`;
			console.log('what is thing! ' + thing);
			    console.log("PATH INFO");
 
				dockerPoke(thing, publishEvent, requestRecord).then(() => {
					homegameCheck().then(() => {
	getBuild(owner, repo, commit).then((pathInfo) => {
					emitEvent(requestRecord.requestId, 'UPLOAD_ZIP');

					uploadZip(pathInfo.zipPath, gameId, requestRecord.requestId).then(() => {
						console.log('uploaded zip for request ' + requestRecord.requestId);
						sendVerifyRequest(requestRecord).then(() => {
							updatePublishRequestState(gameId, sourceInfoHash, REQUEST_STATUS.PENDING_CONFIRMATION);
						});
	
					}).catch(err => {
						console.log('failed to upload zip');
						console.log(err);
						reject();
					});
	});
				}).catch(err => {
						console.error('failed homegames check');
						console.log(err);
						emitEvent(requestRecord.requestId, EVENT_TYPE.FAILURE, `Encountered error: ${err}`);
						updatePublishRequestState(gameId, sourceInfoHash, REQUEST_STATUS.FAILED);
					});
				});
//				}).catch(err => {
//					console.error('Failed poke code step');
//					console.error(err);
//					emitEvent(requestRecord.requestId, EVENT_TYPE.FAILURE, `Encountered error: ${err}`);
//					updatePublishRequestState(gameId, sourceInfoHash, REQUEST_STATUS.FAILED);
//				});
//			}).catch(err => {
//				console.error('Failed download step');
//				console.error(err);
//				emitEvent(requestRecord.requestId, EVENT_TYPE.FAILURE, `Encountered error: ${err}`);
//				updatePublishRequestState(gameId, sourceInfoHash, REQUEST_STATUS.FAILED);
//			});
		    }).catch(err => {
			console.error('Failed verifying github info');
			console.error(err);
			emitEvent(requestRecord.requestId, EVENT_TYPE.FAILURE, `Encountered error: ${err}`);
			updatePublishRequestState(gameId, sourceInfoHash, REQUEST_STATUS.FAILED);
		    });
		});
	});
});

//const data = {
//	Messages: [
//{
//Body: '{"sourceInfoHash": "2f358206095176b94dad5bd624d3195c","gameId": "7c6187de4309faff638fc8ad082b1d5b"}'
//}
//	]
//}
//
//const ting = JSON.stringify(
//{
//  sourceInfoHash: '00a012f426e6ec99de6c54329e823a89',
//  gameId: '7c6187de4309faff638fc8ad082b1d5b'
//});

//console.log(data.Messages[0].Body);

setInterval(() => {
	const sqs = new aws.SQS({region: 'us-west-2'});
	sqs.receiveMessage(params, (err, data) => {
		try {
			if (data && data.Messages) {
				const request = JSON.parse(data.Messages[0].Body);
				console.log(request);
				handlePublishEvent(request);
				const deleteParams = {
				      QueueUrl: params.QueueUrl,
				      ReceiptHandle: data.Messages[0].ReceiptHandle
			        };
			        sqs.deleteMessage(deleteParams, (err, data) => {
					console.log(err);
					console.log(data);
					console.log('deleted');
	    			});
			}

		} catch (e) {
			console.log('error processing message');
			console.log(e);
		}
	});
}, 60 * 1000);
	//
