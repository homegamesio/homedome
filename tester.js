const gameModulePath = process.argv[2];
const path = require('path');
const fs = require('fs');

if (gameModulePath) {
	console.log(`using game path ${gameModulePath}`);
	const rootDir = gameModulePath.replace('index.js', '');
	const nodeModulesPath = path.resolve('node_modules');
	fs.symlink(nodeModulesPath, `${rootDir}/node_modules`, 'dir', (err) => {
            if (!err) {
	        const gameClass = require(gameModulePath);
	        const game = new gameClass();
	        console.log(game);
	        console.log('that was it');

            } else {
		console.log('error');
		console.log(err);
	    }

        });

} else {
	console.log('no path');
}
