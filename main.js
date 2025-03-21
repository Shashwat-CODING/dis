const express = require("express");
const ytdl = require("@distube/ytdl-core");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// Disable update checks for faster startup
process.env.YTDL_NO_UPDATE = 'true';

const app = express();
const PORT = process.env.PORT || 3001;

// Performance optimizations
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Improved cache with longer TTL and prefetching
const videoCache = new Map();
const formatCache = new Map();
const CACHE_TTL = 24 * 3600000; // 24 hours
const MAX_CACHE_SIZE = 1000;

// Load cookies only once at startup
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
let cookies = [];

// Parse cookies from file - optimized version
function parseCookiesFile(filePath) {
  try {
    const cookiesContent = fs.readFileSync(filePath, 'utf8');
    if (!cookiesContent.trim()) return [];
    
    return cookiesContent.split('\n')
      .filter(line => line.trim() && !line.startsWith('#'))
      .map(line => {
        const parts = line.split('\t');
        if (parts.length < 7) return null;
        
        return {
          name: parts[5],
          value: parts[6],
          domain: parts[0],
          path: parts[2],
          expires: parseInt(parts[4]),
          httpOnly: false,
          secure: parts[3] === 'TRUE'
        };
      })
      .filter(Boolean);
  } catch (error) {
    console.error("Error parsing cookies file:", error);
    return [];
  }
}

// Try to load cookies at startup
try {
  cookies = parseCookiesFile(COOKIES_PATH);
  console.log(`Loaded ${cookies.length} cookies from cookies.txt`);
} catch (error) {
  console.error("Failed to load cookies at startup:", error);
}

// Pre-create request options for reuse
const getBaseOptions = () => ({
  requestOptions: cookies.length > 0 ? { cookies } : {}
});

// Cleanup old cache entries
function cleanupCache() {
  if (videoCache.size > MAX_CACHE_SIZE) {
    const now = Date.now();
    let oldestTime = now;
    let oldestKey = null;
    
    while (videoCache.size > MAX_CACHE_SIZE * 0.8) {
      videoCache.forEach((value, key) => {
        if (value.timestamp < oldestTime) {
          oldestTime = value.timestamp;
          oldestKey = key;
        }
      });
      
      if (oldestKey) {
        videoCache.delete(oldestKey);
        oldestKey = null;
        oldestTime = now;
      } else {
        break;
      }
    }
  }
}

// Optimized video info fetching with enhanced caching
async function getCachedVideoInfo(videoId) {
  const cacheKey = videoId;
  
  if (videoCache.has(cacheKey)) {
    const cachedData = videoCache.get(cacheKey);
    if (Date.now() - cachedData.timestamp < CACHE_TTL) {
      return cachedData.info;
    }
    videoCache.delete(cacheKey);
  }
  
  const options = getBaseOptions();
  const info = await ytdl.getInfo(`https://youtube.com/watch?v=${videoId}`, options);
  
  videoCache.set(cacheKey, {
    info,
    timestamp: Date.now()
  });
  
  if (videoCache.size > MAX_CACHE_SIZE) {
    cleanupCache();
  }
  
  return info;
}

// Find the best audio format and cache the decision
function getBestAudioFormat(info, videoId) {
  const formatCacheKey = videoId;
  
  if (formatCache.has(formatCacheKey)) {
    const format = formatCache.get(formatCacheKey);
    const now = Date.now();
    
    if (now - format.timestamp < CACHE_TTL) {
      return format.audioFormat;
    }
    formatCache.delete(formatCacheKey);
  }
  
  const audioFormat = ytdl.chooseFormat(info.formats, { 
    quality: 'highestaudio', 
    filter: 'audioonly' 
  });
  
  if (audioFormat) {
    formatCache.set(formatCacheKey, {
      audioFormat,
      timestamp: Date.now()
    });
  }
  
  return audioFormat;
}

// Helper function to check if a format is likely to work reliably
function isReliableFormat(format) {
  // Check if format has crucial properties that make it more likely to be playable
  return (
    format &&
    format.url && 
    format.contentLength && 
    !format.isHLS && // HLS streams tend to be less reliable
    !format.isDashMPD // DASH manifests need additional processing
  );
}

// MP3 info endpoint with more reliable audio streams
app.get("/mp3/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  if (!videoId) {
    return res.status(400).json({ error: "Missing video ID" });
  }

  try {
    // Fetch video info with caching
    const info = await getCachedVideoInfo(videoId);
    
    // Get all possible audio formats
    const regularAudioFormats = info.formats
      .filter(format => format.mimeType?.includes("audio") && format.audioCodec)
      .map(format => ({
        ...format,
        formatType: "regular",
        isReliable: isReliableFormat(format)
      }));
    
    // Get adaptive formats if available
    const adaptiveAudioFormats = info.player_response?.streamingData?.adaptiveFormats
      ? info.player_response.streamingData.adaptiveFormats
          .filter(format => format.mimeType?.includes("audio") || 
                           (format.audioQuality && !format.qualityLabel))
          .map(format => ({
            ...format,
            formatType: "adaptive",
            isReliable: isReliableFormat(format)
          }))
      : [];
    
    // Combine and sort formats by reliability first, then by bitrate
    const allAudioFormats = [...regularAudioFormats, ...adaptiveAudioFormats]
      .sort((a, b) => {
        // First sort by reliability
        if (a.isReliable && !b.isReliable) return -1;
        if (!a.isReliable && b.isReliable) return 1;
        
        // Then sort by bitrate (higher first)
        return (b.bitrate || 0) - (a.bitrate || 0);
      });

    if (allAudioFormats.length === 0) {
      return res.status(404).json({ error: "No audio stream found" });
    }

    // Get recommended format
    const recommendedFormat = allAudioFormats.find(format => format.isReliable) || allAudioFormats[0];

    // Return audio data
    res.json({
      videoDetails: {
        videoId: info.videoDetails.videoId,
        title: info.videoDetails.title,
        lengthSeconds: info.videoDetails.lengthSeconds,
        author: info.videoDetails.author?.name || null,
        isPrivate: info.videoDetails.isPrivate,
        isLiveContent: info.videoDetails.isLiveContent
      },
      recommendedFormat,
      audioFormats: allAudioFormats
    });
  } catch (error) {
    console.error("MP3 info error:", error.message);
    if (error.message?.includes('sign in')) {
      res.status(401).json({ error: "Authentication required" });
    } else if (error.statusCode === 429) {
      res.status(429).json({ error: "Rate limited" });
    } else {
      res.status(500).json({ error: "Failed to fetch audio data" });
    }
  }
});

// Optimized streaming endpoint
app.get("/stream/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  if (!videoId) {
    return res.status(400).json({ error: "Missing video ID" });
  }

  try {
    // Use caching for format info
    const info = await getCachedVideoInfo(videoId);
    const audioFormat = getBestAudioFormat(info, videoId);
    
    if (!audioFormat) {
      return res.status(404).json({ error: "No suitable audio format found" });
    }

    // Set appropriate headers
    res.header('Content-Type', audioFormat.mimeType || 'audio/webm');
    if (audioFormat.contentLength) {
      res.header('Content-Length', audioFormat.contentLength);
    }
    
    // Create stream with reused options
    const options = {
      ...getBaseOptions(),
      format: audioFormat,
      range: req.headers.range // Support range requests for seeking
    };
    
    // Stream directly to response
    const stream = ytdl(`https://youtube.com/watch?v=${videoId}`, options);
    
    // Handle errors in the stream
    stream.on('error', (err) => {
      console.error(`Stream error for ${videoId}:`, err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Streaming error" });
      }
    });
    
    stream.pipe(res);
    
  } catch (error) {
    console.error("Stream error:", error.message);
    if (error.message?.includes('sign in')) {
      res.status(401).json({ error: "Authentication required" });
    } else if (error.statusCode === 429) {
      res.status(429).json({ error: "Rate limited" });
    } else {
      res.status(500).json({ error: "Failed to stream audio" });
    }
  }
});

// Fast health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    cookiesLoaded: cookies.length > 0,
    cookieCount: cookies.length,
    cacheSize: videoCache.size
  });
});

// Initialize the server with optimizations
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Cookies: ${cookies.length > 0 ? `${cookies.length} loaded` : 'None'}`);
});