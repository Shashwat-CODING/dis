const express = require("express");
const ytdl = require("@distube/ytdl-core");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const app = express();
const PORT = 3100;

app.use(cors());

// Configure ytdl to use cookies
const cookiesFilePath = path.join(__dirname, "cookies.txt");

// Function to read cookies from file
function getCookiesFromFile() {
  try {
    if (fs.existsSync(cookiesFilePath)) {
      const cookiesContent = fs.readFileSync(cookiesFilePath, "utf8");
      return cookiesContent;
    } else {
      console.warn("cookies.txt file not found");
      return "";
    }
  } catch (error) {
    console.error("Error reading cookies file:", error);
    return "";
  }
}

app.get("/streams/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  if (!videoId) {
    return res.status(400).json({ error: "Missing video ID" });
  }

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    // Get cookies from file
    const cookiesContent = getCookiesFromFile();
    
    // Set options with cookies
    const options = {
      requestOptions: {
        headers: {
          cookie: cookiesContent
        }
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
