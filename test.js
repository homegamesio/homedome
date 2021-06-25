const gamePath = "/home/ec2-user/homedome/test-game";
const { exec } = require('child_process');

const cmd = 'strace node ' + gamePath;

console.log(cmd);

exec(cmd, (err, stdout, stderr) => {
	const gameLines = stdout.split('\n');

	const straceLines = stderr.toString().split('\n');

	for (const i in straceLines) {
		const line = straceLines[i];
		if (line.startsWith('open(')) {
			const openTarget = [...line.matchAll(/open\("(\S*)"/g)][0][1];
//			console.log(`opening file or device: ${openTarget}`);
		} else if (line.startsWith('read(')) {
			const readTarget = [...line.matchAll(/read\((\d+),\s*([\S\s]*),\s*(\d+)/g)];
			const bytesRead = readTarget[0][3];
			const fileDescriptor = readTarget[0][1];
//			console.log(`Reading ${bytesRead} bytes from ${fileDescriptor}`);
		} else {
			if (!line.startsWith('clock_gettime(') && !line.startsWith('close(') && !line.startsWith('futex(')) {
				if (line.startsWith('getsockopt(') || line.startsWith('setsockopt(')) {
//					console.log('doing something with a socket');
				} else if (line.startsWith('getsockname(') || line.startsWith('socket(')) {
//					console.log('SUPER doing something with a socket');
				} else if (line.startsWith('connect(')) {
					const connectTarget = [...line.matchAll(/inet_addr\("(\S*)"\)/g)][0][1];
					console.log('making connection to ' + connectTarget);
				} else {
					console.log(line);
				}
			}
		}
	}
});
