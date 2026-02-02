const sharp = require('sharp');
const potrace = require('potrace');
const { optimize } = require('svgo');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const LOGO_DIR = './'; 
const PIN_BACKGROUND = '../pins/pink_master_pin.svg'; 

// DIMENSIONS
const VIEWBOX_SIZE = 24;      
const SCALE = 10;
const PROCESS_CANVAS = VIEWBOX_SIZE * SCALE; // 240px

// VISUAL SAFE ZONE: 16px (160px) to prevent bottom overspill
const SAFE_SIZE_VISUAL = 16; 
const PROCESS_SAFE = SAFE_SIZE_VISUAL * SCALE; // 160px

async function processAllLogos() {
    if (!fs.existsSync(LOGO_DIR)) return console.log(`❌ Directory ${LOGO_DIR} not found.`);
    
    const files = fs.readdirSync(LOGO_DIR).filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file));
    
    let htmlContent = `
    <html>
    <head>
        <style>
            body { font-family: 'Segoe UI', sans-serif; background: #f0f2f5; padding: 20px; }
            h1 { text-align: center; color: #333; }
            .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
            .tile { background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden; }
            .tile-header { background: #007bff; color: white; padding: 10px; font-size: 13px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .tile-body { padding: 15px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; text-align: center; }
            .label { display: block; font-size: 10px; color: #666; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px; }
            .box-24 { width: 24px; height: 24px; margin: 0 auto; position: relative; }
            .border-red { border: 1px solid red; background: white; }
            .border-green { position: absolute; top: 4px; left: 4px; width: 16px; height: 16px; border: 1px dotted #00c853; pointer-events: none; box-sizing: border-box; }
            .pin-bg { position: absolute; top: 0; left: 0; z-index: 1; }
            .pin-fg { position: absolute; top: 0; left: 0; z-index: 2; }
            .color-chip { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:5px; border:1px solid #ccc; }
        </style>
    </head>
    <body>
        <h1>Map Pin Audit (Color & Detail Fix)</h1>
        <div class="grid">`;

    for (const file of files) {
        const inputPath = path.join(LOGO_DIR, file);
        const outputName = file.replace(/\.[^/.]+$/, "") + ".svg";
        const outputPath = path.join(LOGO_DIR, outputName);

        try {
            process.stdout.write(`Processing ${file}... `);
            const hexColor = await convertLogo(inputPath, outputPath);
            console.log(`✅ (${hexColor})`);
            
            htmlContent += `
            <div class="tile">
                <div class="tile-header" title="${file}">${file}</div>
                <div class="tile-body">
                    <div>
                        <span class="label">Original</span>
                        <img src="${file}" height="24" style="object-fit: contain;">
                    </div>
                    <div>
                        <span class="label">Safe Zone</span>
                        <div class="box-24 border-red">
                            <div class="border-green"></div>
                            <img src="${outputName}" width="24" height="24" style="position:relative; z-index:1;">
                        </div>
                    </div>
                    <div>
                        <span class="label">Map View</span>
                        <div class="box-24">
                            <img src="${PIN_BACKGROUND}" width="24" height="24" class="pin-bg">
                            <img src="${outputName}" width="24" height="24" class="pin-fg">
                        </div>
                    </div>
                </div>
                <div style="text-align:center; padding:5px; font-size:10px; color:#666; background:#fafafa; border-top:1px solid #eee;">
                    Trace Color: <span class="color-chip" style="background:${hexColor}"></span>${hexColor}
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
    // 1. ANALYZE COLORS (Foreground vs Background)
    const { fgColorHex, bgColorObj } = await analyzeImageColors(inputPath);

    // 2. PREPARE MASK
    // Create a buffer where Foreground = Black (Trace) and Background = White (Ignore)
    const maskBuffer = await createTraceMask(inputPath, bgColorObj, PROCESS_SAFE);

    // 3. PLACE ON CANVAS (240px)
    // Composite the 160px mask onto the 240px canvas
    const finalCanvas = await sharp({
        create: {
            width: PROCESS_CANVAS,
            height: PROCESS_CANVAS,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 0 }
        }
    })
    .composite([{ input: maskBuffer, gravity: 'center' }])
    .ensureAlpha()
    .raw()
    .toBuffer();

    // 4. TRACE
    // We trace the mask (which is black shape on transparent), but assign the REAL color
    const pathData = await traceBuffer(finalCanvas, PROCESS_CANVAS, PROCESS_CANVAS, fgColorHex);

    // 5. ASSEMBLE SVG with DETECTED COLOR
    const rawSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${VIEWBOX_SIZE}" height="${VIEWBOX_SIZE}" viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}">
            <g transform="scale(${1/SCALE})">
                <path d="${pathData}" fill="${fgColorHex}" fill-rule="evenodd" /> 
            </g>
        </svg>
    `;

    // 6. OPTIMIZE
    const result = optimize(rawSvg, {
        multipass: true,
        plugins: [
            {
                name: 'preset-default',
                params: {
                    overrides: {
                        convertPathData: { floatPrecision: 2 },
                        collapseGroups: false
                    }
                }
            },
            'moveGroupAttrsToElems',
            'collapseGroups',
            { name: 'removeViewBox', active: false }
        ]
    });

    fs.writeFileSync(outputPath, result.data);
    return fgColorHex; // Return color for the audit log
}

// --- HELPER 1: COLOR ANALYSIS ---
async function analyzeImageColors(inputPath) {
    // Resize for speed
    const { data, info } = await sharp(inputPath)
        .resize(100, 100, { fit: 'inside' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    // A. Detect Background from Corners
    const corners = [0, info.width - 1, info.width * (info.height - 1), (info.width * info.height) - 1];
    let rSum=0, gSum=0, bSum=0, count=0;
    
    corners.forEach(idx => {
        const i = idx * 4;
        if (data[i+3] > 200) { // Solid pixel
            rSum += data[i]; gSum += data[i+1]; bSum += data[i+2];
            count++;
        }
    });

    // If corners are solid, we have a Box Background. Otherwise assume Transparent/White.
    const hasBoxBg = count > 2;
    const bgR = hasBoxBg ? Math.round(rSum/count) : 255;
    const bgG = hasBoxBg ? Math.round(gSum/count) : 255;
    const bgB = hasBoxBg ? Math.round(bSum/count) : 255;
    
    // B. Find Dominant Foreground Color
    const colorCounts = {};
    
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
        
        if (a < 128) continue; // Skip transparent
        
        // Calculate difference from background
        const dist = Math.sqrt(Math.pow(r - bgR, 2) + Math.pow(g - bgG, 2) + Math.pow(b - bgB, 2));
        
        // Only count if it's NOT the background
        if (dist > 45) {
            // Quantize colors slightly to group similar shades
            const hex = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
            colorCounts[hex] = (colorCounts[hex] || 0) + 1;
        }
    }

    // Sort by frequency
    const sortedColors = Object.keys(colorCounts).sort((a,b) => colorCounts[b] - colorCounts[a]);
    
    // Default to Black if no color found (e.g. white logo on white bg?), otherwise Top Color
    const fgColorHex = sortedColors.length > 0 ? sortedColors[0] : '#000000';
    
    return {
        fgColorHex,
        bgColorObj: hasBoxBg ? { r: bgR, g: bgG, b: bgB } : null
    };
}

// --- HELPER 2: CREATE TRACE MASK ---
async function createTraceMask(inputPath, bgColorObj, targetSize) {
    // 1. Resize Image to Safe Zone
    const { data, info } = await sharp(inputPath)
        .resize(targetSize, targetSize, { fit: 'contain', background: { r:0,g:0,b:0,alpha:0 } })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const output = Buffer.alloc(data.length);

    for (let i = 0; i < info.width * info.height; i++) {
        const idx = i * 4;
        const r = data[idx], g = data[idx+1], b = data[idx+2], a = data[idx+3];

        let shouldTrace = false;

        if (a < 128) {
            shouldTrace = false; // Transparent = Ignore
        } else if (bgColorObj) {
            // BOX LOGIC: Trace if color differs from Background
            const dist = Math.sqrt(Math.pow(r - bgColorObj.r, 2) + Math.pow(g - bgColorObj.g, 2) + Math.pow(b - bgColorObj.b, 2));
            shouldTrace = dist > 40; 
        } else {
            // STANDARD LOGIC: Trace if opaque
            shouldTrace = true;
        }

        // POTRACE MASKING: 
        // 0 (Black) = Trace this area
        // 255 (White) = Ignore this area
        const val = shouldTrace ? 0 : 255;
        
        output[idx] = val; output[idx+1] = val; output[idx+2] = val; output[idx+3] = 255; // Alpha solid
    }

    return sharp(output, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png()
        .toBuffer();
}

function traceBuffer(buffer, width, height, color) {
    return new Promise(async (resolve) => {
        const tempFile = path.join(LOGO_DIR, `temp_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
        await sharp(buffer, { raw: { width, height, channels: 4 } }).png().toFile(tempFile);

        potrace.trace(tempFile, { 
            turdSize: 1,      // <--- CRITICAL: Set to 1 to preserve small details/holes in text
            optTolerance: 0.2, // Smoother curves
            color: color      // Use the actual detected color
        }, (err, svg) => {
            try { fs.unlinkSync(tempFile); } catch(e){}
            if (err) return resolve('');
            const dMatch = svg.match(/d="([^"]+)"/);
            return resolve(dMatch ? dMatch[1] : '');
        });
    });
}

processAllLogos();