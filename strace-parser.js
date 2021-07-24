// listeners: socket, connect, open, read
const parseOutput = (_lines, listeners = {}) => {
	const lines = _lines.split('\n');
	for (lineIndex in lines) {
		const _line = lines[lineIndex];
		if (_line.startsWith('open(')) {
			const openTarget = [..._line.matchAll(/open\("(\S*)"/g)][0][1];
			listeners['open'] && listeners['open'](_line);	
		} else if (_line.startsWith('read(')) {
			const readTarget = [..._line.matchAll(/read\((\d+),\s*([\S\s]*),\s*(\d+)/g)];
			const bytesRead = readTarget[0][3];
			const fileDescriptor = readTarget[0][1];
			listeners['open'] && listeners['open'](_line);	
		} else {
			if (!_line.startsWith('clock_gettime(') && !_line.startsWith('close(') && !_line.startsWith('futex(')) {
				if (_line.startsWith('getsockopt(') || _line.startsWith('setsockopt(')) {
					listeners['socket'] && listeners['socket'](_line);	
				} else if (_line.startsWith('getsockname(') || _line.startsWith('socket(')) {
					listeners['socket'] && listeners['socket'](_line);	
				} else if (_line.startsWith('connect(')) {
					const connectTarget = [..._line.matchAll(/inet_addr\("(\S*)"\)/g)][0][1];
					listeners['connect'] && listeners['connect'](_line);	
				} else {
				//	console.log(_line);
				}
			}
		}
	
	}
};

module.exports = {
	parseOutput
}
