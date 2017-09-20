var mydbx = require("./mydbx.js");
var fs = require('fs');
var path = require('path');
var request = require('request');

var typeInfo = {
  "": {
    name: "picture",
    containerName: "pictures",
    cacheDirName: "pictures",
    //cacheDir added later, see setCacheBaseDir()
    extToMime: {
      ".jpg": {name: "image/jpeg"}, //tinfo pointer added below to each mime
      ".jpeg": {name: "image/jpeg"},
      ".gif": {name: "image/gif"},
      ".png": {name: "image/png"}
    }
  },
  "V": {
    name: "video",
    containerName: "videos",
    cacheDirName: "videos",
    extToMime: {
      ".mp4": {name: "video/mp4"},
      ".mov": {name: "video/quicktime"},
      ".avi": {name: "video/x-msvideo"},
      ".wmv": {name: "video/x-ms-wmv"},
      ".3gp": {name: "video/3gpp"}
    }
  }
};

var types = Object.keys(typeInfo);

// Add tinfo pointer to each mime object
types.forEach(function(type) {
  var tinfo = typeInfo[type];
  Object.keys(tinfo.extToMime).forEach(function(ext) {
    tinfo.extToMime[ext].tinfo = tinfo;
  });
});

var sizeInfo = {
  'sm': {dbxsz: "w128h128"}, //cacheDir added later, see setCacheBaseDir()
  'md': {dbxsz: "w640h480"},
  'lg': {dbxsz: "w1024h768"}
};

var sizes = Object.keys(sizeInfo);

var cacheBaseDir;

// Called at startup with cache base directory
// Create cache dirs for each type and store path in tinfo object
function setCacheBaseDir(baseDir) {
  cacheBaseDir = baseDir;
  types.forEach(function(type) {
    var tinfo = typeInfo[type];
    tinfo.cacheDir = path.join(baseDir, tinfo.cacheDirName);
    if (!fs.existsSync(tinfo.cacheDir)) {
      fs.mkdirSync(tinfo.cacheDir);
    }
  });
  sizes.forEach(function(size) {
    var szinfo = sizeInfo[size];
    szinfo.cacheDir = path.join(baseDir, "pic-"+size);
    if (!fs.existsSync(szinfo.cacheDir)) {
      fs.mkdirSync(szinfo.cacheDir);
    }
  });
}

function File(parent, meta, parts, mime) {
  this.parent = parent;
  this.name = meta.name;
  this.dbxid = meta.id;
  this.rev = meta.rev;
  this.id = parts.id;
  this.num = parts.num;
  this.mime = mime;
  //console.log("File "+this.id+" created");
}

File.prototype.represent = function() {
  return {
    name: this.name,
    id: this.id
  };
};

File.typeInfo = typeInfo;
File.types = types;
File.sizeInfo = sizeInfo;
File.sizes = sizes;
File.setCacheBaseDir = setCacheBaseDir;

// Return cache file path for this file
// Cache file name includes id and revision
File.prototype.cachePath = function(cacheDir) {
  return path.join(cacheDir, this.id+"_"+this.rev);
};

// Touch access time to indicate recent use
function touchFile(path) {
  var nowSec = Math.trunc(Date.now()/1000);
  fs.utimes(path, nowSec, nowSec);
}

// Return read stream for file
// If file is in cache return file stream, else request download
File.prototype.readStream = function() {
  var self = this;
  var cachePath = this.cachePath(this.mime.tinfo.cacheDir);
  var cachePathTmp;
  var somethingWentWrong = false;
  var rs, ws;

  // all-purpose cleanup function
  function cleanup(what) {
    somethingWentWrong = true;
    if (what.all || what.rs) {
      try {
        rs.end();
      } catch(e) {}
    }
    if (what.all || what.ws) {
      try {
        ws.end();
      } catch (e) {}
    }
    if (what.all || what.tmp) {
      try {
        fs.unlinkSync(cachePathTmp);
      } catch (e) {}
    }
  }
  
  if (fs.existsSync(cachePath)) {
    //console.log(this.id+" found in cache");
    touchFile(cachePath);
    rs= fs.createReadStream(cachePath);
    rs.on('error', function(err) {
      console.log("read failed with "+err.code+" for "+self.id+", cleaning up");
      cleanup({rs: 1});
    });
    rs.on('stop', function() {
      console.log("read "+self.id+" stopped, cleaning up");
      cleanup({rs: 1});
    });
  } else {
    //console.log(this.id+" not in cache, downloading");
    rs = this.requestDownload();
    cachePathTmp = cachePath + "_tmp";
    ws = fs.createWriteStream(cachePathTmp, {flags: "wx"});
    rs.on('error', function(err) {
      console.log("download failed with "+err.code+" for "+self.id+", cleaning up");
      cleanup({all: 1});
    });
    rs.on('stop', function() {
      console.log("download "+self.id+" stopped, cleaning up");
      cleanup({all: 1});
    });
    ws.on('error', function(err) {
      // If two requests for same file collide, one will get EEXIST error
      // Ignore error and let the other request continue to write file
      if (err.code === "EEXIST") {
        console.log("ignoring EEXIST for "+cachePathTmp);
        cleanup({ws: 1});
      } else {
        console.log("write failed with "+err.code+" for "+cachePathTmp+", cleaning up");
        cleanup({ws: 1, tmp: 1});
      }
    });
    ws.on('unpipe', function() {
      console.log("unpipe for "+cachePathTmp+", cleaning up");
      cleanup({ws: 1, tmp: 1});
    });
    ws.on('close', function() {
      if (!somethingWentWrong) {
        fs.renameSync(cachePathTmp, cachePath);
      }
    });
    rs.pipe(ws);
  }
  return rs;
};

// stolen from Dropbox SDK..
var charsToEncode = /[\u007f-\uffff]/g;

function httpHeaderSafeJson(args) {
  return JSON.stringify(args).replace(charsToEncode, function (c) {
    return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

// Request file download and return readable stream
// Note we roll our own request instead of using Dropbox SDK
// Dropbox SDK buffers the whole file and does not support streaming
File.prototype.requestDownload = function() {
  return request.post("https://content.dropboxapi.com/2/files/download", {
    headers: {
      "Authorization": "Bearer "+mydbx.getAccessToken(),
      "Dropbox-API-Arg": httpHeaderSafeJson({path: this.dbxid})
    }
  })
  .on('response', function(res) {
    // clean up headers that we won't want to pass along
    delete res.headers['dropbox-api-result'];
    Object.keys(res.headers).forEach(function(name) {
      switch (name.toLowerCase()) {
        // keep only these
        case "content-length":
        case "etag":
          break;
        default:
          delete res.headers[name];
      }
    });
  })
  .on('error', function(err) {
    console.log("from requestDownload post request", err);
  });
};

// Promise version of fs.readFile()
function readFilePromise(path) {
  return new Promise(function(resolve, reject) {
    fs.readFile(path, function(err, data) {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}

// Write data to file, using a temporary file and renaming at end
// Action is asynchronous and cleans up after itself
function writeFileAsyncWithRename(path, data) {
  var pathTmp = path + "_tmp";
  var somethingWentWrong = false;
  var cleanupTmpFile = true;
  var ws = fs.createWriteStream(pathTmp, {flags: "wx"});

  // what do to if something goes wrong
  ws.on('error', function(err) {
    somethingWentWrong = true;
    // if EEXIST another request must be writing same file, don't delete temp file
    if (err.code === "EEXIST") {
      console.log("ignoring EEXIST for "+pathTmp);
      cleanupTmpFile = false;
    } else {
      console.log("async write failed with "+err.code+" for "+pathTmp);
    }    
  });
  
  // what to do when write finishes
  ws.on('close', function() {
    if (!somethingWentWrong) {
      fs.renameSync(pathTmp, path); //success
    } else {
      // failure, cleanup our temp file
      if (cleanupTmpFile) {
        try {
          fs.unlink(pathTmp);
        } catch (e) {}
      }
    }
  });
  
  // write the data, note stream is always ended here
  ws.end(data, 'binary');
}

File.prototype.getThumbnail = function(size) {
  var szinfo = sizeInfo[size];
  if (szinfo) {
    var cachePath = this.cachePath(szinfo.cacheDir);
    if (fs.existsSync(cachePath)) {
      // return from cache, touch the mod time to indicate recent use
      touchFile(cachePath);
      return readFilePromise(cachePath);
    } else {
      // not found in cache, request from dropbox
      return mydbx.filesGetThumbnail({
        path: this.dbxid,
        size: szinfo.dbxsz
      }).then(function(result) {
        // write to cache (async)
        writeFileAsyncWithRename(cachePath, result.fileBinary);
        // return to caller without waiting for write to finish
        return result.fileBinary;
      });
    }
  } else {
    throw new Error("Unknown size: "+size);
  }
};

module.exports = File;
