const express = require("express");
const ytdl = require("@distube/ytdl-core");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Function to parse Netscape cookies.txt format
function parseCookiesFile(filePath) {
  try {
    const cookiesContent = fs.readFileSync(filePath, 'utf8');
    const cookieLines = cookiesContent.split('\n');
    
    const cookies = [];
    
    for (const line of cookieLines) {
      // Skip comments and empty lines
      if (line.startsWith('#') || line.trim() === '') continue;
      
      // Parse each cookie line (domain, flag, path, secure, expiration, name, value)
      const parts = line.split('\t');
      if (parts.length >= 7) {
        cookies.push({
          domain: parts[0],
          flag: parts[1] === 'TRUE',
          path: parts[2],
          secure: parts[3] === 'TRUE',
          expiration: parseInt(parts[4]),
          name: parts[5],
          value: parts[6]
        });
      }
    }
    
    return cookies;
  } catch (error) {
    console.error("Error parsing cookies file:", error);
    return [];
  }
}

// Convert parsed cookies to the format expected by ytdl-core
function formatCookiesForRequest(cookies) {
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

// Load cookies from file - you'll need to specify the path to your cookies.txt file
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
let cookiesString = '';

// Try to load cookies at startup
try {
  const parsedCookies = parseCookiesFile(COOKIES_PATH);
  cookiesString = formatCookiesForRequest(parsedCookies);
  console.log(`Loaded ${parsedCookies.length} cookies from cookies.txt`);
} catch (error) {
  console.error("Failed to load cookies at startup:", error);
}

// Endpoint to reload cookies
app.post("/reload-cookies", (req, res) => {
  try {
    const parsedCookies = parseCookiesFile(COOKIES_PATH);
    cookiesString = formatCookiesForRequest(parsedCookies);
    res.json({ success: true, message: `Reloaded ${parsedCookies.length} cookies` });
  } catch (error) {
    res.status(500).json({ error: "Failed to reload cookies" });
  }
});

app.get("/mp3/:videoId", async (req, res) => {
  try {
    const videoId = req.params.videoId;
    if (!videoId) {
      return res.status(400).json({ error: "Missing video ID" });
    }

    // Options for ytdl-core with authentication cookies
    const options = {
      requestOptions: {}
    };
    
    // Add cookies to request if available
    if (cookiesString) {
      options.requestOptions.headers = {
        'Cookie': cookiesString
      };
    }

    // Fetch video information using ytdl-core with cookies for authentication
    const info = await ytdl.getInfo(`https://music.youtube.com/watch?v=${videoId}`, options);

    // Filter formats for audio-only streams
    const audioFormats = info.formats.filter(format => format.mimeType.includes("audio") && format.audioCodec);

    if (audioFormats.length === 0) {
      return res.status(404).json({ error: "No audio stream found" });
    }

    res.json({
      videoDetails: info.videoDetails,
      audioFormats: audioFormats
    });
  } catch (error) {
    console.error(error);
    if (error.message.includes('sign in')) {
      res.status(401).json({ error: "Authentication required. Please check your cookies.txt file." });
    } else {
      res.status(500).json({ error: "Failed to fetch video streaming data" });
    }
  }
});

// Endpoint to stream audio directly
app.get("/stream/:videoId", async (req, res) => {
  try {
    const videoId = req.params.videoId;
    if (!videoId) {
      return res.status(400).json({ error: "Missing video ID" });
    }

    // Options for ytdl-core with authentication cookies
    const options = {
      requestOptions: {}
    };
    
    // Add cookies to request if available
    if (cookiesString) {
      options.requestOptions.headers = {
        'Cookie': cookiesString
      };
    }

    // Get info to find the best audio format
    const info = await ytdl.getInfo(`https://music.youtube.com/watch?v=${videoId}`, options);
    
    // Get the highest quality audio-only format
    const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
    
    if (!audioFormat) {
      return res.status(404).json({ error: "No suitable audio format found" });
    }

    // Set headers
    res.header('Content-Type', audioFormat.mimeType);
    res.header('Content-Length', audioFormat.contentLength);
    
    // Stream the audio
    ytdl(`https://music.youtube.com/watch?v=${videoId}`, { 
      format: audioFormat,
      requestOptions: options.requestOptions
    }).pipe(res);
    
  } catch (error) {
    console.error(error);
    if (error.message.includes('sign in')) {
      res.status(401).json({ error: "Authentication required. Please check your cookies.txt file." });
    } else {
      res.status(500).json({ error: "Failed to stream audio" });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Authentication status: ${cookiesString ? 'Cookies loaded' : 'No cookies loaded'}`);
});
