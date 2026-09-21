const http = require("http");
const fs = require("fs");
const path = require("path");
const identify = require("./api/identify");

const PORT = process.env.PORT || 3000;
const CONTENT_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/identify") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        req.body = body ? JSON.parse(body) : {};
      } catch {
        req.body = {};
      }
      res.status = (code) => {
        res.statusCode = code;
        return res;
      };
      res.json = (obj) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(obj));
      };
      await identify(req, res);
    });
    return;
  }

  const filePath = path.join(__dirname, req.url === "/" ? "index.html" : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    res.setHeader("content-type", CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream");
    res.setHeader("cache-control", "no-store");
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Ready! Available at http://localhost:${PORT}`));
