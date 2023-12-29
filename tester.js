const gameModulePath = process.argv[2];
const squishPath = process.argv[3];

const path = require('path');
const fs = require('fs');

process.env.SQUISH_PATH = squishPath;


const runTest = (game) => {
	const gameRoot = game.getRoot && game.getRoot();
	if (!game.getLayers) {
		throw new Error('No getLayers method found');
	} else {
		game.getLayers().forEach(layer => {
			if (!layer.root) {
				throw new Error("No root found for layer");
			}
		});
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
