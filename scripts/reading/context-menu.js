
let elementFromPointIndex = false;
let blankPage = false;
let movingCurrentImageToTrash = false;
let pendingMoveToTrash = {};
let pendingMoveToTrashStack = [];

function show(event, gamepad = false)
{
	const validCoords = event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY);
	const elementFromPoint = !gamepad && validCoords ? document.elementFromPoint(event.clientX, event.clientY) : false;
	const elementFromPointBlankPage = (elementFromPoint && elementFromPoint.classList.contains('blank-page')) ? true : false;

	elementFromPointIndex = (elementFromPoint && elementFromPoint.tagName.toLowerCase() === 'img' && elementFromPoint.dataset.index) ? +elementFromPoint.dataset.index : false;

	const saveImages = (reading.isCanvas() || reading.isEbook()) ? false : true;
	dom.queryAll('.separator-set-as-poster, .reading-context-menu-copy-image, .separator-save-images, .reading-context-menu-save-image, .reading-context-menu-save-all-images, .reading-context-menu-save-bookmarks-images, .reading-context-menu-save-all-bookmarks-images, .reading-context-menu-set-as-poster, .reading-context-menu-set-as-poster-folders').css({display: saveImages ? '' : 'none'});

	if(saveImages)
	{
		const setAsPoster = /app\.asar\.unpacked/.test(reading.readingCurrentPath()) ? false : true;
		dom.queryAll('.separator-set-as-poster, .reading-context-menu-set-as-poster, .reading-context-menu-set-as-poster-folders').css({display: setAsPoster ? '' : 'none'});
	}

	// Blank pages
	const addBlankPage = reading.doublePage.active();
	dom.queryAll('.reading-context-menu-blank-page-left, .reading-context-menu-blank-page-right, .reading-context-menu-blank-page-remove, .separator-blank-page').css({display: addBlankPage ? '' : 'none'});

	blankPage = false;

	if(addBlankPage)
	{
		if(elementFromPointBlankPage)
		{
			const index = +elementFromPoint.dataset.index;
			const auto = +elementFromPoint.dataset.auto;

			blankPage = {index, auto};

			dom.queryAll('.reading-context-menu-blank-page-remove').css({display: !auto ? '' : 'none'});
		}
		else
		{
			dom.queryAll('.reading-context-menu-blank-page-remove').css({display: 'none'});
		}
	}

	if(gamepad)
		events.activeMenu('#reading-context-menu', false, 'gamepad');
	else
		events.activeContextMenu('#reading-context-menu');
}

function getVars()
{
	const currentPath = onReading ? reading.readingCurrentPath() : dom.history.path;
	const pathIsFolder = (currentPath && fs.existsSync(currentPath) && fs.statSync(currentPath).isDirectory()) ? true : false;

	return {
		currentPath: currentPath,
		pathIsFolder: pathIsFolder,
	};
}

function openFileLocation()
{
	const vars = getVars();
	const image = getCurrentImage();

	if(image && !fileManager.containsCompressed(image.path))
		electron.shell.showItemInFolder(image.path)
	else if(vars.pathIsFolder)
		electron.shell.openPath(vars.currentPath)
	else
		electron.shell.showItemInFolder(fileManager.firstCompressedFile(vars.currentPath))
}

function aboutFile()
{
	const vars = getVars();
	dom.fileInfo.show(vars.pathIsFolder ? vars.currentPath : fileManager.lastCompressedFile(vars.currentPath));
}

function labels()
{
	const vars = getVars();
	dom.labels.setLabels(vars.pathIsFolder ? vars.currentPath : fileManager.lastCompressedFile(vars.currentPath));
}

function getCurrentImage(onlyElementFromPoint = false, notElementFromPoint = false)
{
	if(elementFromPointIndex !== false && !notElementFromPoint)
		return reading.getImage(elementFromPointIndex);

	if(onlyElementFromPoint)
		return false;

	const image = reading.getImageByPosition(reading.currentImagePosition(), 0);
	return image || false;
}

function canMoveCurrentImageToTrash(image)
{
	const imagePath = image?.path || false;

	if(!onReading || !imagePath)
		return false;

	if(reading.isCanvas() || reading.isEbook() || reading.doublePage.active())
		return false;

	if(fileManager.isServer(imagePath) || fileManager.lastCompressedFile(p.dirname(imagePath)))
		return false;

	if(/app\.asar\.unpacked/.test(imagePath) || !compatible.image(imagePath) || !fs.existsSync(imagePath))
		return false;

	return true;
}

function getImageAtPosition(position, currentPath)
{
	const images = reading.images();
	const imagesData = reading.imagesData();

	for(let key in images)
	{
		const image = images[key];

		if(image.path !== currentPath && imagesData[key]?.position == position)
			return image;
	}

	return false;
}

function getMoveToTrashTargetImage(image)
{
	const position = reading.currentImagePosition();

	return getImageAtPosition(position + 1, image.path) || getImageAtPosition(position - 1, image.path);
}

function pendingMoveToTrashPath(id, imagePath)
{
	return p.join(tempFolder, 'pending-trash', id, p.basename(imagePath));
}

function addTemporaryUsage(path)
{
	const tmpUsage = storage.get('tmpUsage') || {};
	if(!tmpUsage[path]) tmpUsage[path] = {};
	tmpUsage[path].lastAccess = app.time();
	storage.set('tmpUsage', tmpUsage);
}

function removeTemporaryUsage(path)
{
	const tmpUsage = storage.get('tmpUsage') || {};
	delete tmpUsage[path];
	storage.set('tmpUsage', tmpUsage);
}

function moveFileSync(from, to)
{
	fs.mkdirSync(p.dirname(to), {recursive: true});

	try
	{
		fs.renameSync(from, to);
	}
	catch(error)
	{
		if(error.code !== 'EXDEV')
			throw error;

		const stat = fs.statSync(from);
		fs.copyFileSync(from, to);
		fs.utimesSync(to, stat.atime, stat.mtime);
		fs.unlinkSync(from);
	}
}

function deletePendingMoveToTrash(id)
{
	const pending = pendingMoveToTrash[id];
	if(!pending) return false;

	if(pending.timeout)
		clearTimeout(pending.timeout);
	delete pendingMoveToTrash[id];
	pendingMoveToTrashStack = pendingMoveToTrashStack.filter((pendingId) => pendingId !== id);

	return pending;
}

function schedulePendingMoveToTrash(id)
{
	const pending = pendingMoveToTrash[id];
	if(!pending || pending.timeout) return;

	pending.timeout = setTimeout(function(){
		commitPendingMoveToTrash(id).catch(function(error){console.error(error)});
	}, 6000);
}

async function commitPendingMoveToTrash(id)
{
	const pending = deletePendingMoveToTrash(id);
	if(!pending) return false;

	removeTemporaryUsage(pending.tempPath);

	if(fs.existsSync(pending.tempPath))
		await electron.ipcRenderer.invoke('move-to-trash', pending.tempPath);

	fs.rm(p.dirname(pending.tempPath), {recursive: true, force: true}, function(){});

	return true;
}

async function undoMoveCurrentImageToTrash(id)
{
	const pending = deletePendingMoveToTrash(id);
	if(!pending) return false;

	removeTemporaryUsage(pending.tempPath);

	if(!fs.existsSync(pending.tempPath))
		return false;

	const restorePath = fs.existsSync(pending.originalPath) ? fileManager.genearteFilePath(p.dirname(pending.originalPath), p.basename(pending.originalPath)) : pending.originalPath;
	moveFileSync(pending.tempPath, restorePath);
	fs.rm(p.dirname(pending.tempPath), {recursive: true, force: true}, function(){});

	events.closeSnackbar();
	await dom.openComic(true, restorePath, pending.mainPath);

	return true;
}

function hasPendingMoveToTrash()
{
	return pendingMoveToTrashStack.some((id) => pendingMoveToTrash[id]);
}

async function undoLastMoveCurrentImageToTrash()
{
	for(let i = pendingMoveToTrashStack.length - 1; i >= 0; i--)
	{
		const id = pendingMoveToTrashStack[i];

		if(pendingMoveToTrash[id])
			return undoMoveCurrentImageToTrash(id);
	}

	return false;
}

async function moveCurrentImageToTrash()
{
	if(movingCurrentImageToTrash)
		return false;

	const image = getCurrentImage(false, true);

	if(!canMoveCurrentImageToTrash(image))
		return false;

	const targetImage = getMoveToTrashTargetImage(image);
	const currentPath = reading.readingCurrentPath();
	const mainPath = dom.history.mainPath;
	const id = sha1(image.path+'-'+Date.now()+'-'+Math.random());
	const tempPath = pendingMoveToTrashPath(id, image.path);

	movingCurrentImageToTrash = true;

	try
	{
		moveFileSync(image.path, tempPath);
		addTemporaryUsage(tempPath);

		pendingMoveToTrash[id] = {
			originalPath: image.path,
			tempPath,
			mainPath,
			timeout: false,
		};
		pendingMoveToTrashStack.push(id);

		if(targetImage && fs.existsSync(targetImage.path))
			await dom.openComic(true, targetImage.path, mainPath);
		else
			await dom.loadIndexPage(true, currentPath, false, false, mainPath, false, true);

		events.snackbar({
			key: 'moveCurrentImageToTrash-'+id,
			text: language.global.contextMenu.moveToTrash,
			duration: 6,
			buttons: [
				{
					text: language.buttons.undo,
					function: 'reading.contextMenu.undoMoveCurrentImageToTrash(\''+id+'\');',
				},
			],
		});

		schedulePendingMoveToTrash(id);

		return true;
	}
	catch(error)
	{
		console.error(error);
		return false;
	}
	finally
	{
		movingCurrentImageToTrash = false;
	}
}

async function flushPendingMoveToTrash()
{
	const ids = Object.keys(pendingMoveToTrash);

	for(const id of ids)
		await commitPendingMoveToTrash(id);
}

function setAsPoster()
{
	const image = getCurrentImage();
	if(!image) return;

	dom.poster.setAsPoster(image.path);
}

function setAsPosterFolders()
{
	const image = getCurrentImage();
	if(!image) return;

	dom.poster.setAsPosterFolders(image.path, dom.history.mainPath);
}

function generateFileName(path, page, leadingZeros, fileName)
{
	// Parent folder name
	let parentFolderName = p.dirname(p.dirname(path));
	let ext1 = p.extname(parentFolderName);
	parentFolderName = p.basename(parentFolderName, (ext1 && ext1.length < 6 ? ext1 : ''));

	// Current file/folder name
	let folderName = p.dirname(path);
	let ext2 = p.extname(folderName);
	folderName = p.basename(folderName, (ext2 && ext2.length < 6 ? ext2 : ''));

	const extension = p.extname(path);
	const imageName = p.basename(path, extension);

	fileName = fileName.replace(/\[parentFolder(?:Name)?\]/, parentFolderName);
	fileName = fileName.replace(/\[folder(?:Name)?\]/, folderName);
	fileName = fileName.replace(/\[image(?:Name)?\]/, imageName);
	fileName = fileName.replace(/\[page\]/, String(page).padStart(leadingZeros, '0'));
	fileName = fileName.replace(/\[pageInt\]/, page);

	let ext3 = p.extname(fileName);
	if(!ext3 || ext3.length >= 6) fileName += extension;

	return fileName;
}

function saveImage()
{
	const position = reading.currentImagePosition();
	const image = getCurrentImage(true);

	saveAllImages(position, image);
}

function saveAllImages(position = false, image = false, _return = false)
{
	const images = reading.images();
	const imagesData = reading.imagesData();

	const toSave = [];
	let highestPage = 0;

	for(let key in images)
	{
		if(!image)
		{
			const path = images[key].path;

			if(position === false || position == imagesData[key].position)
				toSave.push({path: path, page: key});
		}

		if(+key > highestPage)
			highestPage = +key;
	}

	if(image)
		toSave.push({path: image.path, page: image.index});

	if(_return)
		return toSave;

	saveImages(toSave, String(highestPage).length);
}

function saveBookmarksImages(loadBookmarks = false)
{
	saveAllBookmarksImages(loadBookmarks, true);
}

function saveAllBookmarksImages(loadBookmarks = false, onlyCurrent = false)
{
	if(loadBookmarks) reading.loadBookmarks();
	const bookmarks = handlebarsContext.bookmarks;

	const toSave = [];
	let highestPage = 0;

	for(let i = 0, len = bookmarks.length; i < len; i++)
	{
		const folder = bookmarks[i];

		if((!onlyCurrent || folder.current) && !folder.continueReading)
		{
			for(let i = 0, len = folder.bookmarks.length; i < len; i++)
			{
				const bookmark = folder.bookmarks[i];

				toSave.push({path: bookmark.path, page: bookmark.index});

				if(bookmark.index > highestPage)
					highestPage = bookmark.index;
			}
		}
	}

	saveImages(toSave, String(highestPage).length);
}

function saveImages(toSave = [], leadingZeros = 3)
{
	if(config.saveImageToFolder)
	{
		const saveImageFolder = relative.resolve(config.saveImageFolder);
		fileManager.macosStartAccessingSecurityScopedResource(saveImageFolder);
		_saveImages(toSave, leadingZeros, saveImageFolder, config.saveImageTemplate);
	}
	else
	{
		const saveDialog = macosMAS ? saveDialogDirectory : saveDialogFile;

		saveDialog(async function(saveTo, fileName){

			_saveImages(toSave, leadingZeros, saveTo, fileName);

		});
	}

}

async function _saveImages(toSave = [], leadingZeros = 3, saveTo, fileName)
{
	const currentTime = new Date();
	let first = '';

	if(toSave.length)
	{
		let file = fileManager.file(p.dirname(toSave[0].path));
		await file.makeAvailable(toSave);
		file.destroy();

		const len = toSave.length;

		for(let i = 0; i < len; i++)
		{
			const image = toSave[i];
			const realPath = fileManager.realPath(image.path);
			const saveImageTo = fileManager.genearteFilePath(saveTo, generateFileName(image.path, image.page, leadingZeros, fileName));
			if(first === '') first = saveImageTo;

			if(!fs.existsSync(saveImageTo))
			{
				fs.copyFileSync(realPath, saveImageTo);
				fs.utimes(saveImageTo, currentTime, currentTime, function(){});
			}
		}
	
		events.snackbar({
			key: 'saveAllImages',
			text: len === 1 ? language.global.contextMenu.saveImageMessage : language.global.contextMenu.saveImagesMessage,
			duration: 6,
			buttons: [
				{
					text: language.global.open,
					function: 'electron.shell.showItemInFolder(\''+escapeQuotes(escapeBackSlash(first), 'simples')+'\');',
				},
			],
		});
	}
	else
	{
		console.error('No images to save');
	}
}

function saveDialogFile(callback)
{
	electronRemote.dialog.showSaveDialog({properties: ['openDirectory', 'createDirectory'], buttonLabel: language.buttons.save, defaultPath: config.saveImageTemplate}).then(function(result) {

		if(!result.canceled && result.filePath)
			callback(p.dirname(result.filePath), p.basename(result.filePath));

	});
}

function saveDialogDirectory(callback)
{
	electronRemote.dialog.showOpenDialog({properties: ['openDirectory', 'createDirectory'], buttonLabel: language.buttons.save}).then(function(files) {

		if(files.filePaths && files.filePaths[0] && fs.statSync(files.filePaths[0]).isDirectory())
			callback(files.filePaths[0], (config.saveImageTemplate === '[parentFolder] - [folder] - [image] - [page]' ? '[folder] - [image] - [page]' : config.saveImageTemplate));

	});
}

async function copyImageToClipboard()
{
	const position = reading.currentImagePosition();
	const _image = getCurrentImage(true);
	let images = saveAllImages(position, _image, true);
	let len = images.length;

	if(!len)
		return;

	if(_config.readingManga && !reading.readingViewIs('scroll'))
		images = images.reverse();

	for(let i = 0; i < len; i++)
	{
		images[i].image = fileManager.realPath(images[i].path);
	}

	const sizes = await image.getSizes(images);
	let maxHeight = 0;

	for(let i = 0; i < len; i++)
	{
		const size = sizes[i];

		if(size.height > maxHeight)
			maxHeight = size.height;
	}

	// Generate new sizes
	const resizes = [];
	let sumWidth = 0;

	for(let i = 0; i < len; i++)
	{
		const size = sizes[i];
		const factor = maxHeight / size.height;
		const width = Math.round(size.width * factor);

		resizes.push({
			width: width,
			height: Math.round(size.height * factor),
		});

		sumWidth += width;
	}

	// Resize images to blob and put them on canvas
	const canvas = document.createElement('canvas');
	canvas.width = sumWidth;
	canvas.height = maxHeight;
	const ctx = canvas.getContext('2d');

	let left = 0;

	for(let i = 0; i < len; i++)
	{
		let src = images[i].image;
		let path = images[i].path;

		const size = resizes[i];
		const options = {
			width: size.width,
			height: size.height,
			kernel: 'lanczos3',
			compressionLevel: 0,
		};

		if(compatible.image.blob(path)) // Convert unsupported images
			src = await workers.convertImage(path, {priorize: true});

		let data = await image.resizeToBlob(src, options);

		// Draw image
		const img = new Image();
		img.src = data.blob;
		await img.decode();
		ctx.drawImage(img, left, 0);

		left += size.width;

		URL.revokeObjectURL(data.blob);
	}

	const nativeImage = electron.nativeImage.createFromDataURL(canvas.toDataURL());

	electron.clipboard.writeImage(nativeImage, 'clipboard');

	events.snackbar({
		key: 'copyImageToClipboard',
		text: language.global.contextMenu.copyImageMessage,
		duration: 6,
		buttons: [
			{
				text: language.buttons.dismiss,
				function: 'events.closeSnackbar();',
			},
		],
	});
}

function isRightImage(index)
{
	const imagesData = reading.imagesData();
	const imagesDistribution = reading.imagesDistribution();

	const position = imagesData[index]?.position;

	return imagesDistribution[position]?.[0]?.index !== index;
}

function addBlankPage(right = false)
{
	const image = getCurrentImage(false, true);
	if(!image) return;

	const key = p.dirname(dom.history.path);
	const customBlankPages = storage.getKey('customBlankPages', key) ?? {};

	const index = image.index - (!right || isRightImage(image.index) ? 1 : 0);
	const value = (customBlankPages[index] ?? 0) + 1;

	customBlankPages[index] = value;
	storage.setKey('customBlankPages', key, customBlankPages);

	reading.reloadAnimated(false);
}

function removeBlankPage()
{
	if(blankPage === false) return;
	if(blankPage.auto) return;

	const key = p.dirname(dom.history.path);
	const customBlankPages = storage.getKey('customBlankPages', key) ?? {};

	const index = blankPage.index;
	const value = (customBlankPages[index] ?? 0) - 1;

	if(value <= 0)
		delete customBlankPages[index];
	else
		customBlankPages[index] = value;

	if(app.empty(customBlankPages))
		storage.deleteKey('customBlankPages', key);
	else
		storage.setKey('customBlankPages', key, customBlankPages);

	reading.reloadAnimated(false);
}

module.exports = {
	show: show,
	openFileLocation: openFileLocation,
	aboutFile: aboutFile,
	labels: labels,
	setAsPoster: setAsPoster,
	setAsPosterFolders: setAsPosterFolders,
	saveImage: saveImage,
	saveAllImages: saveAllImages,
	saveBookmarksImages: saveBookmarksImages,
	saveAllBookmarksImages: saveAllBookmarksImages,
	copyImageToClipboard: copyImageToClipboard,
	moveCurrentImageToTrash: moveCurrentImageToTrash,
	undoMoveCurrentImageToTrash: undoMoveCurrentImageToTrash,
	undoLastMoveCurrentImageToTrash: undoLastMoveCurrentImageToTrash,
	hasPendingMoveToTrash: hasPendingMoveToTrash,
	flushPendingMoveToTrash: flushPendingMoveToTrash,
	addBlankPage: addBlankPage,
	removeBlankPage: removeBlankPage,
};