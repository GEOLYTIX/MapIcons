const sharp = require('sharp');
const potrace = require('potrace');
const { optimize } = require('svgo');
const fs = require('fs');
const path = require('path');

// CONFIG
const LOGO_DIR = './';
const TARGET_SIZE = 24;
const PROCESS_SCALE = 10; 
const PROCESS_SIZE = TARGET_SIZE * PROCESS_SCALE; // 240px

async function processAllLogos() {
    if (!fs.existsSync(LOGO_DIR)) {
        console.log(`❌ Directory ${LOGO_DIR} not found.`);
        return;
    }
    
    const files = fs.readdirSync(LOGO_DIR).filter(file => /\.(png|jpg|jpeg)$/i.test(file));
    console.log(`📂 Found ${files.length} images to process...`);

    let htmlContent = `<html><head><style>
        body{font-family:sans-serif;background:#eee;padding:20px;}
        .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:20px;}
        .card{background:white;padding:15px;border-radius:8px;text-align:center;}
        .preview { border: 1px solid #ccc; background-image: linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%); background-size: 10px 10px; background-position: 0 0, 0 5px, 5px -5px, -5px 0px; }
    </style></head><body><h1>24px SVG Audit</h1><div class="grid">`;

    for (const file of files) {
        const inputPath = path.join(LOGO_DIR, file);
        const outputName = file.replace(/\.[^/.]+$/, "") + ".svg";
        const outputPath = path.join(LOGO_DIR, outputName);

        try {
            // --- DEBUG STEP: CHECK FILE FORMAT ---
            const metadata = await sharp(inputPath).metadata();
            if (metadata.format !== 'png' && metadata.format !== 'jpeg') {
                console.warn(`⚠️  WARNING: ${file} is actually a [${metadata.format.toUpperCase()}], not a PNG/JPG. Sharp might fail.`);
            }
            // -------------------------------------

            process.stdout.write(`Processing: ${file}... `);
            await convertToHighFidelity(inputPath, outputPath);
            console.log(`✅ Done`);
            
            htmlContent += `
            <div class="card">
                <div style="font-weight:bold; margin-bottom:10px; overflow:hidden; text-overflow:ellipsis;">${file}</div>
                <div style="display:flex; justify-content:center; gap:15px; align-items:end;">
                    <div><img src="${file}" height="64"><br><small>Original (${metadata.format})</small></div>
                    <div><img src="${outputName}" class="preview" width="24" height="24"><br><small>24px SVG</small></div>
                </div>
            </div>`;
        } catch (err) {
            console.log(`\n❌ ERROR on ${file}:`);
            console.log(`   Reason: ${err.message}`);
            // If it's a specific Sharp error, it often means the file header is corrupt or mismatched
        }
    }
    
    fs.writeFileSync(path.join(LOGO_DIR, 'audit.html'), htmlContent + `</div></body></html>`);
    console.log(`\n🎉 Batch complete. Open ${path.join(LOGO_DIR, 'audit.html')} to verify.`);
}

async function convertToHighFidelity(inputPath, outputPath) {
    // 1. PRE-PROCESS: Resize to 240x240
    // We add .png() at the end of the chain to force format conversion in memory
    const rawBuffer = await sharp(inputPath)
        .resize(PROCESS_SIZE, PROCESS_SIZE, { 
            fit: 'contain', 
            background: { r: 255, g: 255, b: 255, alpha: 0 } 
        })
        .ensureAlpha()
        .toFormat('png') // FORCE PNG format in buffer to prevent "unsupported" errors downstream
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { data, info } = rawBuffer;

    // 2. DETECT BACKGROUND (Corner Check)
    const corners = [0, info.width - 1, info.width * (info.height - 1), (info.width * info.height) - 1];
    let bgColor = null;
    const getHex = (idx) => {
        const r = data[idx * 4], g = data[idx * 4 + 1], b = data[idx * 4 + 2];
        return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
    };
    const cornerColors = corners.map(c => getHex(c));
    if (cornerColors[0] === cornerColors[3]) bgColor = cornerColors[0];

    // 3. COLOR ANALYSIS
    const colorCounts = {};
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
        if (a < 128) continue; 
        const hex = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
        if (hex === '#ffffff') continue; 
        if (bgColor && hex === bgColor) continue;
        colorCounts[hex] = (colorCounts[hex] || 0) + 1;
    }

    let sortedColors = Object.keys(colorCounts)
        .sort((a, b) => colorCounts[b] - colorCounts[a])
        .slice(0, 3);
    
    if (sortedColors.length === 0) sortedColors = ['#000000'];

    // 4. TRACE LAYERS
    let svgPaths = [];
    for (const color of sortedColors) {
        const rT = parseInt(color.slice(1, 3), 16);
        const gT = parseInt(color.slice(3, 5), 16);
        const bT = parseInt(color.slice(5, 7), 16);

        const maskPixels = Buffer.alloc(info.width * info.height * 4);
        let pixelCount = 0;

        for (let i = 0; i < info.width * info.height; i++) {
            const idx = i * 4;
            const dist = Math.sqrt(Math.pow(data[idx]-rT,2) + Math.pow(data[idx+1]-gT,2) + Math.pow(data[idx+2]-bT,2));
            const isMatch = dist < 30 && data[idx+3] > 128;
            if (isMatch) pixelCount++;
            const val = isMatch ? 0 : 255; 
            maskPixels[idx] = val; maskPixels[idx+1] = val; maskPixels[idx+2] = val; maskPixels[idx+3] = 255; 
        }

        if (pixelCount === 0) continue;
        const pathData = await traceBuffer(maskPixels, info.width, info.height, color);
        if (pathData) svgPaths.push(pathData);
    }

    // 5. ASSEMBLE & OPTIMIZE (Fixed Plugins)
    const rawSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${TARGET_SIZE}" height="${TARGET_SIZE}" viewBox="0 0 ${TARGET_SIZE} ${TARGET_SIZE}">
        <g transform="scale(${1/PROCESS_SCALE})">
            ${svgPaths.join('')}
        </g>
    </svg>`;

    // Corrected Plugin Structure
    const result = optimize(rawSvg, {
        multipass: true,
        plugins: [
            {
                name: 'preset-default',
                params: {
                    overrides: {
                        // We ONLY override what exists. 
                        // If removeViewBox isn't here, we don't touch it.
                        // We force path data precision to be clean.
                        convertPathData: { floatPrecision: 2 },
                        // If you encounter "collapsing groups" issues, you can toggle this:
                        collapseGroups: false 
                    },
                },
            },
            // These run AFTER the preset
            'moveGroupAttrsToElems', 
            'collapseGroups',
            // Explicitly ensure viewBox is kept (though standard preset usually keeps it if width/height are present)
            { name: 'removeViewBox', active: false } 
        ]
    });

    fs.writeFileSync(outputPath, result.data);
}

function traceBuffer(buffer, width, height, color) {
    return new Promise(async (resolve) => {
        const tempFile = path.join(LOGO_DIR, `temp_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
        await sharp(buffer, { raw: { width, height, channels: 4 } }).png().toFile(tempFile);

        potrace.trace(tempFile, { turdSize: 10, optTolerance: 0.4, color: color }, (err, svg) => {
            try { fs.unlinkSync(tempFile); } catch(e){}
            if (err) return resolve(null);
            const dMatch = svg.match(/d="([^"]+)"/);
            if (!dMatch) return resolve(null);
            const d = dMatch[1];
            if (d.length < 50 && d.includes('M0 0')) return resolve(null);
            resolve(`<path d="${d}" fill="${color}" fill-rule="evenodd" />`);
        });
    });
}

processAllLogos();