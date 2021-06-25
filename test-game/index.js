const http = require('http');
const https = require('https');
const fs = require('fs');

console.log('hello i am a test game');

https.get('https://google.com', (err, res) => {
	console.log(err);
	console.log(res);
	console.log('I got this back');
});
