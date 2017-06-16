#!/usr/bin/env nodejs
var fs = require('fs');
var http = require('http');
var mydbx = require("./mydbx.js");
var Folder = require("./folder.js");
var root;

mydbx.filesGetMetadata({path: '/Pictures'})
  .then(function(response) {
    root = new Folder(null, response);
    root.update().then(function(){console.log("it is finished")});
  })
  .catch(function(error) {
    console.log(error);
  });

http.createServer(function (req, res) {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.write("This is a test");
  res.end('Hello World 2\n');
}).listen(8081, 'localhost');
console.log('Server running at http://localhost:8081/');

