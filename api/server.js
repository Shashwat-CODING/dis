const express = require("express");
const ytdl = require("@distube/ytdl-core");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const app = express();
const PORT = 3100;

app.use(cors());

// Path to cookies file
const cookiesFilePath = path.join(__dirname, "cookies.txt");

// Function to parse Netscape format cookies into JSON format
function parseNetscapeCookies(cookieContent) {
  const cookies = [];
  
  // Split the content by lines and process each line
  const lines = cookieContent.split('\n');
  
  for (const line of lines) {
    // Skip comments and empty lines
    if (line.startsWith('#') || line.trim() === '') {
      continue;
    }
    
    // Split the line by tabs
    const parts = line.split('\t');
    
    // Ensure we have enough parts
    if (parts.length >= 7) {
      const domain = parts[0];
      const path = parts[2];
      const secure = parts[3] === 'TRUE';
      const expirationDate = parseInt(parts[4]);
      const name = parts[5];
      const value = parts[6];
      
      cookies.push({
        name,
        value,
        domain,
        path,
        expirationDate,
        secure,
        httpOnly: false // Not specified in Netscape format, default to false
      });
    }
  }
  
  return cookies;
}

app.get("/streams/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  if (!videoId) {
    return res.status(400).json({ error: "Missing video ID" });
  }

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    // Read and parse cookies
    let cookies = [];
    if (fs.existsSync(cookiesFilePath)) {
      const cookiesContent = fs.readFileSync(cookiesFilePath, "utf8");
      cookies = parseNetscapeCookies(cookiesContent);
    } else {
      console.warn("cookies.txt file not found");
    }
    
    // Set options with cookies in the new format
    const options = {
      requestOptions: {
        // The new format requires an array of cookie objects
        cookies: cookies
      }
    };

    // Get video info with cookies
    const info = await ytdl.getInfo(url, options);
    const audioFormats = ytdl.filterFormats(info.formats, "audioonly");
    
    if (audioFormats.length > 0) {
      return res.json({
        audioUrl: audioFormats[0].url,
        title: info.videoDetails.title,
      });
    } else {
      return res.status(404).json({ error: "No audio streams found" });
    }
  } catch (error) {
    console.error("Error fetching audio:", error);
    return res.status(500).json({ error: "Failed to fetch audio" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
