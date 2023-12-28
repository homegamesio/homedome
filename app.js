const aws = require('aws-sdk');
const { exec } = require('child_process');
const dns = require('dns');
const fs = require('fs');
const https = require('https');
const unzipper = require('unzipper');
const archiver = require('archiver');
const crypto = require('crypto');
const process = require('process');
const { v4: uuidv4 } = require('uuid');

const sqs = new aws.SQS({region: 'us-west-2'});

const params = {
	QueueUrl: process.env.QUEUE_URL,
	MaxNumberOfMessages: 1,
	VisibilityTimeout: 60
};

const sendVerificationEmail = (emailAddress, code) => new Promise((resolve, reject) => {
	const ses = new aws.SES({region: process.env.SES_REGION});
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
                        Data: `<html><body><a href="https://landlord.homegames.io/verify_publish_request?code=${code}">here</a> to confirm this submission</body></html>`
                    }   
                },
                Subject: {
                    Charset: 'UTF-8',
                    Data: 'Testing'
                }
            },
            Source: 'landlord@homegames.io'
        };
        ses.sendEmail(params, (err, data) => {
            err ? reject(err) : resolve(data);
        });
});

//const testEvent = {"sourceInfoHash":"c395eb3e071efaa2f5a97e06c4cfba95","gameId":"bfd25172863c6f5e7dee90ac41e6b421"};

// succeed
//const testEvent = {"sourceInfoHash":"e3983ea094207c602038e90639e2304e","gameId":"a67ca99c91000eb95621b6b15ffd6da5"};

//fail
//const testEvent = {"sourceInfoHash":"0be40b1e081445b27bfec4ba8ff434f6","gameId":"576ac0a1863709d815bf6cbbb98411eb"};


const { parseOutput } = require('./strace-parser');

const updatePublishRequestState = (gameId, sourceInfoHash, newStatus) => new Promise((resolve, reject) => {
	const ddb = new aws.DynamoDB({
       		region: process.env.DYNAMO_REGION
        });

        const updateParams = {
            TableName: process.env.PUBLISH_REQUEST_TABLE,
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
            region: process.env.DYNAMO_REGION
        });

        const params = {
            TableName: process.env.PUBLISH_REQUEST_TABLE,
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
                    resolve({
			requestId: _item.request_id.S,
			repoOwner: _item.repo_owner.S,
			created: _item.created.N,
			repoName: _item.repo_name.S,
			requester: _item.requester.S,
			state: _item.status.S,
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
	SUCCESS: "SUCCESS"
};

const REQUEST_STATUS = {
	SUBMITTED: "SUBMITTED",
	PROCESSING: "PROCESSING",
	FAILED: "FAILED",
	PENDING_APPROVAL: "PENDING_APPROVAL",
	APPROVED: "APPROVED",
	PUBLISHED: "PUBLISHED"
};

const emitEvent = (requestId, eventType, message = null) => new Promise((resolve, reject) => {

    const client = new aws.DynamoDB({
        region: process.env.DYNAMO_REGION
    });

    const params = {
        TableName: process.env.PUBLISH_EVENT_TABLE,
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

const getBuild = (owner, repo, commit = undefined) => new Promise((resolve, reject) => {
    // todo: uuid
    const dir = `/tmp/${Date.now()}`;

    const commitString = commit ? '/' + commit : '';
    const file = fs.createWriteStream(dir + '.zip');
    const zlib = require('zlib');
    const thing = `https://codeload.github.com/${owner}/${repo}/zip${commitString}`;
    const archive = archiver('zip');
    const output = fs.createWriteStream(dir + 'out.zip');

	console.log('downloading ' + thing);
	console.log(dir);

    https.get(thing, (_response) => {
        output.on('close', () => {
            fs.readdir(dir, (err, files) => {
                resolve({
                    path: dir + '/' + files[0],
                    zipPath: dir + 'out.zip'
                });
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


const downloadCode = (publishRequest) => new Promise((resolve, reject) => {
	console.log('i am downloading code');
	emitEvent(publishRequest.requestId, EVENT_TYPE.DOWNLOAD);
	getBuild(publishRequest.repoOwner, publishRequest.repoName, publishRequest.commitHash).then((pathInfo) => {
		resolve(pathInfo);
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

const homegamesPoke = (publishRequest, entryPoint, gameId, sourceInfoHash) => new Promise((resolve, reject) => {
	const cmd = 'strace node tester ' + entryPoint;

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
				console.log('not sure what to do here yet: ' + line);
			},
			'read': (line) => {
				console.log('not sure what to do here yet: ' + line);
			}
		};
		exec(cmd, (err, stdout, straceOutput) => {
			parseOutput(straceOutput, listeners);
			console.log('stdout');
			console.log(stdout);
			console.log('err');
			console.log(err);
			if (failed || err) {
				reject();
			} else {
				resolve();
			}
		});	
	});
});

const pokeCode = (publishRequest, codePath, gameId, sourceInfoHash) => new Promise((resolve, reject) => {
	console.log('i am poking code');
	emitEvent(publishRequest.requestId, EVENT_TYPE.POKE);
	checkIndex(codePath.path).then(entryPoint => {
		homegamesPoke(publishRequest, entryPoint, gameId, sourceInfoHash).then(() => {
			resolve();
		});
	}).catch(() => {
		emitEvent(publishRequest.requestId, EVENT_TYPE.FAILURE, 'No index.js found');
		reject();
	});
});

const homegameCheck = (entryPointPath) => new Promise((resolve, reject) => {
	console.log('i am verifying homegames code');
	resolve();
});

const publishVersion = (publishRequest) => new Promise((resolve, reject) => {
	console.log('i am publishing version of code');
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
			sendVerificationEmail(email, code).then(() => {
				resolve();
			});
		});
	});
});

const GITHUB_USER = process.env.GITHUB_USER;
const GITHUB_KEY = process.env.GITHUB_KEY;

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

const handlePublishEvent = (publishEvent) => new Promise((resolve, reject) => {
  
	const { gameId, sourceInfoHash } = publishEvent;

	console.log('publish event');
	console.log(publishEvent);

	updatePublishRequestState(gameId, sourceInfoHash, REQUEST_STATUS.PROCESSING).then(() => {
		getPublishRequestRecord(gameId, sourceInfoHash).then((requestRecord) => {
			console.log('request record');
			console.log(requestRecord);
			downloadCode(requestRecord).then(pathInfo => {
				pokeCode(requestRecord, pathInfo, gameId, sourceInfoHash).then(() => {
					homegameCheck().then(() => {
						sendVerifyRequest(requestRecord).then(() => {
							updatePublishRequestState(gameId, sourceInfoHash, REQUEST_STATUS.PENDING_APPROVAL);
						});
						//publishVersion().then(() => {
						//});
					}).catch(err => {
						console.error('failed homegames check');
						console.log(err);
						updatePublishRequestState(gameId, sourceInfoHash, REQUEST_STATUS.FAILED);
					});
				}).catch(err => {
					console.error('Failed poke code step');
					console.error(err);
					updatePublishRequestState(gameId, sourceInfoHash, REQUEST_STATUS.FAILED);
				});
			}).catch(err => {
				console.error('Failed download step');
				console.error(err);
				updatePublishRequestState(gameId, sourceInfoHash, REQUEST_STATUS.FAILED);
			});
		});
	});
});

setInterval(() => {
	sqs.receiveMessage(params, (err, data) => {
		console.log(err);
		console.log(data);
		if (data.Messages) {
			const request = JSON.parse(data.Messages[0].Body);
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
	});
}, 5000);

//handlePublishEvent(testEvent);
