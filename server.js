import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3847;

// OpenAI API key - set OPENAI_API_KEY in Railway environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.warn('WARNING: OPENAI_API_KEY not set - /extract endpoint will fail');
}

app.use(cors());
app.use(express.json({ limit: '500mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'template-api', version: '1.1.0' });
});

// Try multiple TikTok download methods
async function getTikTokVideo(url) {
  console.log('Trying to download TikTok video...');
  
  // Method 1: TikWM GET
  try {
    console.log('Method 1: TikWM GET...');
    const response = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
    const data = await response.json();
    if (data.code === 0 && data.data?.play) {
      console.log('TikWM GET success!');
      return {
        title: data.data.title || 'TikTok Video',
        author: data.data.author?.nickname || data.data.author?.unique_id || 'Creator',
        duration: data.data.duration || 30,
        videoUrl: data.data.play || data.data.hdplay,
        thumbnail: data.data.origin_cover || data.data.cover
      };
    }
  } catch (e) { console.log('TikWM GET failed:', e.message); }

  // Method 2: TikWM POST
  try {
    console.log('Method 2: TikWM POST...');
    const response = await fetch('https://www.tikwm.com/api/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `url=${encodeURIComponent(url)}&hd=1`
    });
    const data = await response.json();
    if (data.code === 0 && data.data?.play) {
      console.log('TikWM POST success!');
      return {
        title: data.data.title || 'TikTok Video',
        author: data.data.author?.nickname || 'Creator',
        duration: data.data.duration || 30,
        videoUrl: data.data.play || data.data.hdplay,
        thumbnail: data.data.origin_cover || data.data.cover
      };
    }
  } catch (e) { console.log('TikWM POST failed:', e.message); }

  // Method 3: yt-dlp via shell (if available)
  try {
    console.log('Method 3: yt-dlp...');
    const { stdout } = await execAsync(`yt-dlp -j "${url}" 2>/dev/null`);
    const info = JSON.parse(stdout);
    if (info.url || info.formats?.[0]?.url) {
      console.log('yt-dlp success!');
      return {
        title: info.title || 'TikTok Video',
        author: info.uploader || 'Creator',
        duration: info.duration || 30,
        videoUrl: info.url || info.formats?.[0]?.url,
        thumbnail: info.thumbnail
      };
    }
  } catch (e) { console.log('yt-dlp failed:', e.message); }

  // Method 4: Snaptik API
  try {
    console.log('Method 4: Snaptik API...');
    const response = await fetch('https://snaptik.app/abc2.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `url=${encodeURIComponent(url)}`
    });
    const text = await response.text();
    const urlMatch = text.match(/https:\/\/[^"'\s]+\.mp4[^"'\s]*/);
    if (urlMatch) {
      console.log('Snaptik success!');
      return {
        title: 'TikTok Video',
        author: 'Creator',
        duration: 30,
        videoUrl: urlMatch[0],
        thumbnail: ''
      };
    }
  } catch (e) { console.log('Snaptik failed:', e.message); }

  throw new Error('All download methods failed');
}

// Extract template from TikTok URL
app.post('/extract', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  console.log('Processing URL:', url);
  const tempDir = `/tmp/template-${Date.now()}`;
  
  try {
    await fs.mkdir(tempDir, { recursive: true });
    
    const videoData = await getTikTokVideo(url);
    const { videoUrl, duration } = videoData;
    
    console.log('Video info:', { title: videoData.title, duration, hasVideo: !!videoUrl });
    
    console.log('Downloading video...');
    const videoPath = path.join(tempDir, 'video.mp4');
    const downloadResponse = await fetch(videoUrl);
    const videoBuffer = await downloadResponse.arrayBuffer();
    await fs.writeFile(videoPath, Buffer.from(videoBuffer));
    
    console.log('Extracting frames with ffmpeg...');
    const framesDir = path.join(tempDir, 'frames');
    await fs.mkdir(framesDir, { recursive: true });
    
    await execAsync(`ffmpeg -i "${videoPath}" -vf "fps=1" "${framesDir}/frame_%02d.jpg" 2>/dev/null`);
    
    const frameFiles = (await fs.readdir(framesDir)).filter(f => f.endsWith('.jpg')).sort();
    console.log(`Extracted ${frameFiles.length} frames`);
    
    const frames = [];
    for (const frameFile of frameFiles) {
      const framePath = path.join(framesDir, frameFile);
      const frameBuffer = await fs.readFile(framePath);
      const base64 = frameBuffer.toString('base64');
      frames.push({ file: frameFile, base64 });
    }
    
    console.log('Sending frames to GPT-4o...');
    const analysis = await analyzeFramesWithGPT4o(frames, videoData.title, duration);
    
    await fs.rm(tempDir, { recursive: true, force: true });
    
    res.json({
      success: true,
      videoInfo: {
        title: videoData.title,
        author: videoData.author,
        duration,
        thumbnail: videoData.thumbnail
      },
      framesExtracted: frames.length,
      analysis
    });
    
  } catch (error) {
    console.error('Error processing video:', error);
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
    res.status(500).json({ error: error.message });
  }
});

async function analyzeFramesWithGPT4o(frames, title, duration) {
  const prompt = `Analyze these TikTok video frames. Read ALL text overlays you see.

IMPORTANT: Find EVERY numbered location (1), 2), 3)... up to the highest number). 
Don't stop at 5 or 10 - some videos have 15-20+ locations.

For each frame, extract:
- The numbered location text (like "1) Dean's Village" or "5) Afternoon Tea at The Willow")
- Any intro/hook text
- Any outro/CTA text
- FONT STYLE: Describe the font used

Return this JSON:
{
  "hookText": "the intro title text you see",
  "locations": [
    {"number": 1, "name": "exact location name from frame", "timestamp": 1},
    {"number": 2, "name": "exact location name from frame", "timestamp": 2}
  ],
  "outroText": "any ending text",
  "totalLocations": <count of locations found>,
  "fontStyle": {
    "titleFont": {
      "style": "sans-serif|serif|script|display",
      "weight": "regular|bold|heavy",
      "description": "brief description"
    },
    "locationFont": {
      "style": "sans-serif|serif|script|display", 
      "weight": "regular|bold|heavy",
      "description": "brief description"
    }
  }
}

Read the ACTUAL text from frames. Don't guess or make up locations.`;

  const content = [{ type: 'text', text: prompt }];
  
  for (let i = 0; i < frames.length; i++) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${frames[i].base64}` }
    });
    content.push({ type: 'text', text: `[Frame ${i + 1} at ~${i} seconds]` });
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [{ role: 'user', content }]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const responseText = data.choices?.[0]?.message?.content || '';
  
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }
  
  return { raw: responseText };
}

// ============================================
// VIDEO RENDERING ENDPOINT
// ============================================

const FONT_FILES = {
  'Poppins': '/usr/share/fonts/googlefonts/Poppins-Bold.ttf',
  'Poppins-SemiBold': '/usr/share/fonts/googlefonts/Poppins-SemiBold.ttf',
  'Montserrat': '/usr/share/fonts/googlefonts/Montserrat-Bold.ttf',
  'Playfair Display': '/usr/share/fonts/googlefonts/PlayfairDisplay-Bold.ttf',
  'Dancing Script': '/usr/share/fonts/googlefonts/DancingScript-Bold.ttf',
  'Bebas Neue': '/usr/share/fonts/googlefonts/BebasNeue-Regular.ttf',
  'Oswald': '/usr/share/fonts/googlefonts/Oswald-Bold.ttf',
  'Anton': '/usr/share/fonts/googlefonts/Anton-Regular.ttf',
};

function getTextY(position, fontSize) {
  switch (position) {
    case 'top': return fontSize + 50;
    case 'center': return '(h-text_h)/2';
    case 'bottom': 
    default: return `h-${fontSize + 80}`;
  }
}

function escapeFFmpegText(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'\\''")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%');
}

// Render video from clips + text overlays
app.post('/render', async (req, res) => {
  const { clips, outputWidth = 1080, outputHeight = 1920 } = req.body;
  
  if (!clips || !Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: 'clips array is required' });
  }

  console.log(`Rendering video with ${clips.length} clips...`);
  const tempDir = `/tmp/render-${Date.now()}`;
  
  try {
    await fs.mkdir(tempDir, { recursive: true });
    
    // Step 1: Download all clips
    console.log('Downloading clips...');
    const clipPaths = [];
    
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const clipPath = path.join(tempDir, `clip_${i}.mp4`);
      
      if (clip.videoUrl) {
        const response = await fetch(clip.videoUrl);
        if (!response.ok) throw new Error(`Failed to download clip ${i}: ${response.status}`);
        const buffer = await response.arrayBuffer();
        await fs.writeFile(clipPath, Buffer.from(buffer));
      } else if (clip.videoBase64) {
        const buffer = Buffer.from(clip.videoBase64, 'base64');
        await fs.writeFile(clipPath, buffer);
      } else {
        throw new Error(`Clip ${i} has no videoUrl or videoBase64`);
      }
      
      clipPaths.push({ path: clipPath, ...clip });
      console.log(`Downloaded clip ${i + 1}/${clips.length}`);
    }
    
    // Step 2: Process each clip (trim, scale, add text)
    console.log('Processing clips...');
    const processedPaths = [];
    
    for (let i = 0; i < clipPaths.length; i++) {
      const clip = clipPaths[i];
      const processedPath = path.join(tempDir, `processed_${i}.mp4`);
      
      let filters = [];
      filters.push(`scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease,pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2:black`);
      
      if (clip.textOverlay && clip.textOverlay.trim()) {
        const text = clip.textOverlay;
        const style = clip.textStyle || {};
        const fontFamily = style.fontFamily || 'Poppins';
        const fontSize = style.fontSize || 48;
        const fontColor = (style.color || '#FFFFFF').replace('#', '');
        const position = style.position || 'bottom';
        
        const fontFile = FONT_FILES[fontFamily] || FONT_FILES['Poppins'];
        
        let displayText = text;
        if (style.hasEmoji && style.emoji) {
          if (style.emojiPosition === 'before' || style.emojiPosition === 'both') {
            displayText = `${style.emoji} ${displayText}`;
          }
          if (style.emojiPosition === 'after' || style.emojiPosition === 'both') {
            displayText = `${displayText} ${style.emoji}`;
          }
        }
        
        const escapedText = escapeFFmpegText(displayText);
        const yPos = getTextY(position, fontSize);
        
        filters.push(`drawtext=text='${escapedText}':fontfile='${fontFile}':fontsize=${fontSize}:fontcolor=${fontColor}:x=(w-text_w)/2:y=${yPos}:shadowcolor=black@0.7:shadowx=2:shadowy=2`);
      }
      
      const filterStr = filters.join(',');
      
      let inputOpts = '';
      if (clip.trimStart !== undefined) {
        inputOpts += ` -ss ${clip.trimStart}`;
      }
      if (clip.trimDuration !== undefined) {
        inputOpts += ` -t ${clip.trimDuration}`;
      } else if (clip.duration) {
        inputOpts += ` -t ${clip.duration}`;
      }
      
      const cmd = `ffmpeg -y${inputOpts} -i "${clip.path}" -vf "${filterStr}" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart "${processedPath}" 2>&1`;
      
      console.log(`Processing clip ${i + 1}...`);
      await execAsync(cmd);
      processedPaths.push(processedPath);
    }
    
    // Step 3: Concat all clips
    console.log('Concatenating clips...');
    const concatListPath = path.join(tempDir, 'concat.txt');
    const concatContent = processedPaths.map(p => `file '${p}'`).join('\n');
    await fs.writeFile(concatListPath, concatContent);
    
    const outputPath = path.join(tempDir, 'output.mp4');
    await execAsync(`ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${outputPath}" 2>&1`);
    
    // Step 4: Return as base64
    console.log('Reading output...');
    const outputBuffer = await fs.readFile(outputPath);
    const outputBase64 = outputBuffer.toString('base64');
    const stats = await fs.stat(outputPath);
    
    await fs.rm(tempDir, { recursive: true, force: true });
    
    console.log(`Render complete! Size: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
    
    res.json({
      success: true,
      videoBase64: outputBase64,
      mimeType: 'video/mp4',
      sizeBytes: stats.size,
      sizeMB: (stats.size / 1024 / 1024).toFixed(2)
    });
    
  } catch (error) {
    console.error('Render error:', error);
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
    res.status(500).json({ error: error.message });
  }
});

// List available fonts
app.get('/fonts', (req, res) => {
  res.json({ fonts: Object.keys(FONT_FILES) });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Template API v1.1.0 running on port ${PORT}`);
});
