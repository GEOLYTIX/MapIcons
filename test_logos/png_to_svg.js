const sharp = require('sharp');
const potrace = require('potrace');
const { optimize } = require('svgo');
const fs = require('fs');
const path = require('path');

// CONFIG
const LOGO_DIR = './';
const CANVAS_SIZE = 24;      // The size of the SVG viewbox (pin size)
const LOGO_SIZE = 20;        // The maximum size of the logo inside the pin
const PROCESS_SCALE = 10;    // Process at 10x resolution for quality
const PROCESS_CANVAS = CANVAS_SIZE * PROCESS_SCALE; // 240px
const PROCESS_LOGO = LOGO_SIZE * PROCESS_SCALE;     // 200px

async function processAllLogos() {
    if (!fs.existsSync(LOGO_DIR)) {
        console.log(`❌ Directory ${LOGO_DIR} not found.`);
        return;
    }
    
    const files = fs.readdirSync(LOGO_DIR).filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file));
    console.log(`📂 Found ${files.length} images to process...`);

    let htmlContent = `<html><head><style>
        body{font-family:sans-serif;background:#eee;padding:20px;}
        .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:20px;}
        .card{background:white;padding:15px;border-radius:8px;text-align:center;}
        /* Checkerboard pattern to prove transparency */
        .preview { border: 1px solid #ccc; background-image: linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%); background-size: 10px 10px; background-position: 0 0, 0 5px, 5px -5px, -5px 0px; }
        .pin-mockup { width: 24px; height: 24px; background: rgba(255,0,0,0.1); display: inline-block; border: 1px dashed red; }
    </style></head><body><h1>20px Logo in 24px Pin Audit</h1><div class="grid">`;

    for (const file of files) {
        const inputPath = path.join(LOGO_DIR, file);
        const outputName = file.replace(/\.[^/.]+$/, "") + ".svg";
        const outputPath = path.join(LOGO_DIR, outputName);

        try {
            process.stdout.write(`Processing: ${file}... `);
            const metadata = await sharp(inputPath).metadata();
            await convertToHighFidelity(inputPath, outputPath);
            console.log(`✅ Done`);
            
            htmlContent += `
            <div class="card">
                <div style="font-weight:bold; margin-bottom:10px; overflow:hidden; text-overflow:ellipsis;">${file}</div>
                <div style="display:flex; justify-content:center; gap:15px; align-items:center;">
                    <div><img src="${file}" height="48" style="object-fit:contain"><br><small>Original</small></div>
                    <div><div class="preview" style="display:flex; align-items:center; justify-content:center; width:30px; height:30px;"><img src="${outputName}"></div><br><small>SVG</small></div>
                </div>
            </div>`;
        } catch (err) {
            console.log(`\n❌ ERROR on ${file}: ${err.message}`);
        }
    }
    
    fs.writeFileSync(path.join(LOGO_DIR, 'audit.html'), htmlContent + `</div></body></html>`);
    console.log(`\n🎉 Batch complete. Open ${path.join(LOGO_DIR, 'audit.html')} to verify.`);
}

async function convertToHighFidelity(inputPath, outputPath) {
    // 1. PRE-PROCESS & CENTERING
    // We create a blank canvas (240x240) and composite the resized logo (200x200) into the absolute center.
    // This effectively adds the padding we need (20px buffer on all sides in hi-res, which becomes 2px in 24px).
    
    const resizedLogo = await sharp(inputPath)
        .resize(PROCESS_LOGO, PROCESS_LOGO, { fit: 'contain', background: { r:0, g:0, b:0, alpha:0 } })
        .toFormat('png')
        .toBuffer();

    const rawBuffer = await sharp({
        create: {
            width: PROCESS_CANVAS,
            height: PROCESS_CANVAS,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 0 }
        }
    })
    .composite([{ input: resizedLogo, gravity: 'center' }]) // Centered!
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

    const { data, info } = rawBuffer;

    // 2. INTELLIGENT COLOR & BACKGROUND DETECTION
    // We analyze the image to see if it's a "Box Logo" (like Dulux/FarrowBall).
    // If the center pixel is white/light and corners are dark -> It's a colored logo on transparent.
    // If the center pixel is white and corners are white -> Standard logo.
    // If the corners are COLORED -> It is likely a "Box Logo" and we need to strip the box.
    
    const getPixel = (x, y) => {
        const idx = (y * info.width + x) * 4;
        return { r: data[idx], g: data[idx+1], b: data[idx+2], a: data[idx+3] };
    };

    const topLeft = getPixel(0, 0); // Check padding area (should be transparent from our composite)
    // Actually, we resized it into a transparent box, so corners of the *canvas* are transparent.
    // We need to check the corners of the *actual logo content* (index 20,20 since we padded by 20px).
    
    const contentCorner = getPixel(20, 20); // Top-left of the actual logo image content
    
    let isBoxLogo = false;
    let backgroundColorToRemove = null;

    // If the corner of the image content is NOT transparent and NOT white, it's a Box Logo.
    if (contentCorner.a > 128 && (contentCorner.r < 250 || contentCorner.g < 250 || contentCorner.b < 250)) {
        isBoxLogo = true;
        backgroundColorToRemove = contentCorner;
    }

    // 3. COLOR EXTRACTION
    const colorCounts = {};
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
        if (a < 128) continue; 
        
        // If it's a box logo, IGNORE the background box color entirely.
        if (isBoxLogo && Math.abs(r - backgroundColorToRemove.r) < 20 && Math.abs(g - backgroundColorToRemove.g) < 20 && Math.abs(b - backgroundColorToRemove.b) < 20) {
            continue;
        }

        const hex = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
        if (hex === '#ffffff') continue; // Always ignore pure white
        
        colorCounts[hex] = (colorCounts[hex] || 0) + 1;
    }

    let sortedColors = Object.keys(colorCounts)
        .sort((a, b) => colorCounts[b] - colorCounts[a])
        .slice(0, 3);
    
    // Fallback: If we stripped everything (e.g., white text on blue box), 
    // we might have 0 colors left because we ignored white.
    // In that case, we actually want to trace the WHITE text, but color it White (or Black/Grey for map visibility).
    // For map pins, usually you want the text to be visible. Let's assume we trace it as the original text color (White).
    if (sortedColors.length === 0 && isBoxLogo) {
        // We need to find the text color (likely white/light). 
        sortedColors = ['#ffffff']; 
    } else if (sortedColors.length === 0) {
        sortedColors = ['#000000'];
    }

    // 4. TRACE
    let svgPaths = [];
    for (const color of sortedColors) {
        // Special Handling for White Text on Box Logo
        // If we are tracing white text, we need to invert the logic: Trace where pixels ARE white.
        const isWhiteTrace = (color.toLowerCase() === '#ffffff' || color.toLowerCase() === '#fff');
        
        const rT = parseInt(color.slice(1, 3), 16);
        const gT = parseInt(color.slice(3, 5), 16);
        const bT = parseInt(color.slice(5, 7), 16);

        const maskPixels = Buffer.alloc(info.width * info.height * 4);
        
        for (let i = 0; i < info.width * info.height; i++) {
            const idx = i * 4;
            const r = data[idx], g = data[idx+1], b = data[idx+2], a = data[idx+3];

            if (a < 128) {
                // Transparent is white (background) for potrace
                maskPixels[idx] = maskPixels[idx+1] = maskPixels[idx+2] = 255; maskPixels[idx+3] = 255;
                continue;
            }

            let isMatch = false;

            if (isWhiteTrace) {
                // Match anything very light
                if (r > 200 && g > 200 && b > 200) isMatch = true;
            } else {
                // Standard color match
                const dist = Math.sqrt(Math.pow(r-rT,2) + Math.pow(g-gT,2) + Math.pow(b-bT,2));
                if (dist < 40) isMatch = true;
            }

            // Potrace traces BLACK. So Match = Black (0), Non-Match = White (255)
            const val = isMatch ? 0 : 255;
            maskPixels.fill(val, idx, idx + 3);
            maskPixels[idx+3] = 255;
        }

        const pathData = await traceBuffer(maskPixels, info.width, info.height, color);
        if (pathData) svgPaths.push(pathData);
    }

    // 5. ASSEMBLE
    // Note scale is 0.1 (240 -> 24px). The centering happened in Step 1.
    const rawSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" viewBox="0 0 ${CANVAS_SIZE} ${CANVAS_SIZE}">
        <g transform="scale(${1/PROCESS_SCALE})">
            ${svgPaths.join('')}
        </g>
    </svg>`;

    const result = optimize(rawSvg, {
        multipass: true,
        plugins: [
            {
                name: 'preset-default',
                params: {
                    overrides: {
                        convertPathData: { floatPrecision: 2 },
                        collapseGroups: false 
                    },
                },
            },
            'moveGroupAttrsToElems', 
            'collapseGroups',
            { name: 'removeViewBox', active: false } 
        ]
    });

    fs.writeFileSync(outputPath, result.data);
}

function traceBuffer(buffer, width, height, color) {
    return new Promise(async (resolve) => {
        const tempFile = path.join(LOGO_DIR, `temp_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
        await sharp(buffer, { raw: { width, height, channels: 4 } }).png().toFile(tempFile);

        potrace.trace(tempFile, { turdSize: 20, optTolerance: 0.4, color: color }, (err, svg) => {
            try { fs.unlinkSync(tempFile); } catch(e){}
            if (err) return resolve(null);
            
            const dMatch = svg.match(/d="([^"]+)"/);
            if (!dMatch) return resolve(null);
            const d = dMatch[1];
            
            // Box Killer: If path covers > 80% of image, it's likely the bounding box we failed to remove
            if (d.length < 100 && d.includes('M0 0')) return resolve(null);
            
            resolve(`<path d="${d}" fill="${color}" fill-rule="evenodd" />`);
        });
    });
}

processAllLogos();