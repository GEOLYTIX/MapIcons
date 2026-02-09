const sharp = require('sharp');
const potrace = require('potrace');
const { optimize } = require('svgo');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const LOGO_DIR = './'; 
const PIN_BACKGROUND = '../pins/pink_master_pin.svg'; 

// DIMENSIONS & SCALING
const VIEWBOX_SIZE = 24;      
const SCALE = 10;
const PROCESS_CANVAS = VIEWBOX_SIZE * SCALE; // 240px

// --- GEOMETRY SETTINGS ---
// Maximize usage of the pin head (Bulb).
// Target box is 18x14 centered at (12, 9).
const MAX_WIDTH = 18 * SCALE;  // 180px 
const MAX_HEIGHT = 14 * SCALE; // 140px 
const HEAD_CENTER_X = 12 * SCALE; // 120px
const HEAD_CENTER_Y = 9 * SCALE;  // 90px

async function processAllLogos() {
    if (!fs.existsSync(LOGO_DIR)) return console.log(`❌ Directory ${LOGO_DIR} not found.`);
    
    const files = fs.readdirSync(LOGO_DIR).filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file));
    
    let htmlContent = `
    <html>
    <head>
        <style>
            body { font-family: 'Segoe UI', sans-serif; background: #e0e0e0; padding: 20px; }
            h1 { text-align: center; color: #333; }
            .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
            .tile { background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); overflow: hidden; }
            .tile-header { background: #333; color: white; padding: 10px; font-size: 13px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .tile-body { padding: 15px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; text-align: center; align-items: end; }
            .label { display: block; font-size: 10px; color: #666; margin-bottom: 5px; text-transform: uppercase; font-weight:bold; }
            .box-24 { width: 24px; height: 24px; margin: 0 auto; position: relative; background: #ccc; border-radius: 4px; border: 1px solid #999; }
            .box-24.original { background: white; border-color: #eee; }
            .pin-bg { position: absolute; top: 0; left: 0; z-index: 1; }
            .pin-fg { position: absolute; top: 0; left: 0; z-index: 10; }
            .footer { text-align:center; padding:8px; font-size:11px; color:#555; background:#f9f9f9; border-top:1px solid #eee; display:flex; justify-content:space-between; align-items:center; }
            .color-chip { width:12px; height:12px; border-radius:50%; border:1px solid rgba(0,0,0,0.2); display:inline-block; vertical-align:middle; margin-right:4px; }
        </style>
    </head>
    <body>
        <h1>Map Pin Audit (Double Trim Fix)</h1>
        <div class="grid">`;

    for (const file of files) {
        const inputPath = path.join(LOGO_DIR, file);
        const outputName = file.replace(/\.[^/.]+$/, "") + ".svg";
        const outputPath = path.join(LOGO_DIR, outputName);

        try {
            process.stdout.write(`Processing ${file}... `);
            const { hexColor, method } = await convertLogo(inputPath, outputPath);
            console.log(`✅ [${method}]`);
            
            htmlContent += `
            <div class="tile">
                <div class="tile-header" title="${file}">${file}</div>
                <div class="tile-body">
                    <div>
                        <span class="label">Original</span>
                        <div class="box-24 original">
                            <img src="${file}" height="24" style="max-width:24px; object-fit: contain;">
                        </div>
                    </div>
                    <div>
                        <span class="label">SVG Result</span>
                        <div class="box-24">
                            <img src="${outputName}" width="24" height="24" style="position:relative; z-index:2;">
                        </div>
                    </div>
                    <div>
                        <span class="label">Map Context</span>
                        <div class="box-24" style="background:transparent; border:none;"> 
                            <img src="${PIN_BACKGROUND}" width="24" height="24" class="pin-bg">
                            <img src="${outputName}" width="24" height="24" class="pin-fg">
                        </div>
                    </div>
                </div>
                <div class="footer">
                    <span>${method}</span>
                    <span><span class="color-chip" style="background:${hexColor}"></span>${hexColor}</span>
                </div>
            </div>`;
        } catch (err) {
            console.log(`❌ Error: ${err.message}`);
        }
    }
    
    fs.writeFileSync(path.join(LOGO_DIR, 'audit.html'), htmlContent + `</div></body></html>`);
    console.log(`\n👉 Open ${path.join(LOGO_DIR, 'audit.html')} to verify.`);
}

async function convertLogo(inputPath, outputPath) {
    // 1. SMART EXTRACTION (Double Trim)
    // This removes outer borders, finds the text inside, and trims again.
    const analysis = await extractAndTrim(inputPath);
    const { maskBuffer, fillColor, method } = analysis;

    // 2. RESIZE (MAXIMIZE)
    // Now that maskBuffer is "tight" to the content, we can resize it to the full MAX_WIDTH.
    const resizedMask = await sharp(maskBuffer)
        .resize({
            width: MAX_WIDTH,
            height: MAX_HEIGHT,
            fit: 'contain', 
            background: { r:255, g:255, b:255, alpha:1 } 
        })
        .png() 
        .toBuffer();

    // 3. CENTER
    const { info: maskInfo } = await sharp(resizedMask).toBuffer({ resolveWithObject: true });
    
    const left = Math.round(HEAD_CENTER_X - (maskInfo.width / 2));
    const top = Math.round(HEAD_CENTER_Y - (maskInfo.height / 2));

    // 4. COMPOSITE
    const finalCanvas = await sharp({
        create: {
            width: PROCESS_CANVAS,
            height: PROCESS_CANVAS,
            channels: 3,
            background: { r: 255, g: 255, b: 255 }
        }
    })
    .composite([{ 
        input: resizedMask, 
        top: Math.max(0, top), 
        left: Math.max(0, left)
    }])
    .png()
    .toBuffer();

    // 5. TRACE
    const pathData = await traceBuffer(finalCanvas, fillColor);

    // 6. ASSEMBLE SVG
    const rawSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${VIEWBOX_SIZE}" height="${VIEWBOX_SIZE}" viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}">
            <g transform="scale(${1/SCALE})">
                <path d="${pathData}" fill="${fillColor}" fill-rule="evenodd" /> 
            </g>
        </svg>
    `;

    // 7. OPTIMIZE
    const result = optimize(rawSvg, {
        multipass: true,
        plugins: [
            {
                name: 'preset-default',
                params: {
                    overrides: {
                        convertPathData: { floatPrecision: 2 }
                    }
                }
            }
        ]
    });

    fs.writeFileSync(outputPath, result.data);
    return { hexColor: fillColor, method };
}

// --- INTELLIGENT "DOUBLE TRIM" MASKING ---
async function extractAndTrim(inputPath) {
    // STEP 1: Initial Trim (Peel Outer Layer)
    // Remove uniform borders (e.g. white padding around a blue box logo)
    const trimmedInput = await sharp(inputPath)
        .trim({ threshold: 10 }) // Remove uniform border
        .toBuffer();

    // Analyze the *Trimmed* image
    const { data, info } = await sharp(trimmedInput)
        .resize(800, 800, { fit: 'inside' }) 
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    // Identify Background from the corners of the *trimmed* image
    // If it's a Box Logo, the corners are now the Box Color (e.g., Blue for Herbol)
    const corners = [0, info.width-1, info.width*(info.height-1), (info.width*info.height)-1];
    let bgR=0, bgG=0, bgB=0, bgCount=0;
    
    // Check transparency first
    let transparentCount = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i+3] < 50) transparentCount++;
    }
    const isTransparent = transparentCount > (data.length / 4) * 0.1;

    if (!isTransparent) {
        // Opaque: Average the corners
        corners.forEach(idx => {
            const i = idx * 4;
            bgR += data[i]; bgG += data[i+1]; bgB += data[i+2];
            bgCount++;
        });
        bgR = Math.round(bgR/bgCount); bgG = Math.round(bgG/bgCount); bgB = Math.round(bgB/bgCount);
    }

    // STEP 2: Masking
    // Create mask: Match Background -> White, Mismatch -> Black
    const maskRaw = Buffer.alloc(info.width * info.height * 3);
    const fgPixels = [];

    for (let i = 0; i < info.width * info.height; i++) {
        const idx = i * 4;
        const outIdx = i * 3;
        
        const r = data[idx], g = data[idx+1], b = data[idx+2], a = data[idx+3];
        let isLogo = false;

        if (a < 100) {
            isLogo = false; // Transparent is BG
        } else if (isTransparent) {
            isLogo = true;  // If transparent image, all opaque pixels are logo
        } else {
            // Box Logic: If pixel differs from Box Color, it's text
            const dist = Math.sqrt(Math.pow(r-bgR,2) + Math.pow(g-bgG,2) + Math.pow(b-bgB,2));
            isLogo = dist > 45; // Threshold
        }

        if (isLogo) {
            // Foreground -> Black
            maskRaw[outIdx] = 0; maskRaw[outIdx+1] = 0; maskRaw[outIdx+2] = 0;
            fgPixels.push({r, g, b});
        } else {
            // Background -> White
            maskRaw[outIdx] = 255; maskRaw[outIdx+1] = 255; maskRaw[outIdx+2] = 255;
        }
    }

    // Determine Fill Color (from the extracted foreground pixels)
    let fillColor = '#000000';
    if (fgPixels.length > 0) {
        let r=0, g=0, b=0;
        fgPixels.forEach(p => { r+=p.r; g+=p.g; b+=p.b });
        const len = fgPixels.length;
        fillColor = '#' + [Math.round(r/len), Math.round(g/len), Math.round(b/len)]
            .map(c => c.toString(16).padStart(2,'0')).join('');
    }

    // STEP 3: Second Trim (Zoom to Content)
    // The maskRaw currently contains the logo (black) surrounded by white space (where box used to be).
    // We trim this white space away to get a tight bounding box around the text.
    const finalMaskBuffer = await sharp(maskRaw, { raw: { width: info.width, height: info.height, channels: 3 } })
        .trim({ threshold: 10, background: {r:255, g:255, b:255} }) // Trim White surrounding
        .png()
        .toBuffer();

    return { 
        maskBuffer: finalMaskBuffer, 
        fillColor, 
        method: isTransparent ? 'Transparent Extract' : 'Box Drill-Down' 
    };
}

function traceBuffer(buffer, color) {
    return new Promise((resolve, reject) => {
        const params = {
            turdSize: 20, 
            optTolerance: 0.2,
            color: color 
        };
        
        potrace.trace(buffer, params, (err, svg) => {
            if (err) return reject(err);
            const dMatch = svg.match(/d="([^"]+)"/);
            resolve(dMatch ? dMatch[1] : '');
        });
    });
}

processAllLogos();