const gameModulePath = process.argv[2];
const path = require('path');
const fs = require('fs');

const runTest = (game) => {
	const gameRoot = game.getRoot && game.getRoot();
	if (!gameRoot) {
		throw new Error('No game root');
	}
};

if (gameModulePath) {
	console.log(`using game path ${gameModulePath}`);
	const rootDir = gameModulePath.replace('index.js', '');
	const nodeModulesPath = path.resolve('node_modules');
	fs.symlink(nodeModulesPath, `${rootDir}/node_modules`, 'dir', (err) => {
            if (!err) {
		try {
			const timeout = setTimeout(() => {
				throw new Error("Test timed out");
			}, 5000);
		        const gameClass = require(gameModulePath);
		        const game = new gameClass();
			runTest(game);
			clearTimeout(timeout);
		} catch (err) {
			console.log(err);
			throw new Error(err);
		}
            } else {
		console.log('error');
		console.log(err);
	    }

        });

} else {
    console.log('no path');
}

