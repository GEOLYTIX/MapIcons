const sharp = require('sharp');
const potrace = require('potrace');
const { optimize } = require('svgo');
const fs = require('fs');
const path = require('path');

const LOGO_DIR = './test_logos';

async function processAllLogos() {
    if (!fs.existsSync(LOGO_DIR)) return;
    const files = fs.readdirSync(LOGO_DIR).filter(file => /\.(png|jpg|jpeg)$/i.test(file));
    
    let htmlContent = `<html><head><style>
        body{font-family:sans-serif;background:#e0e0e0;padding:20px;}
        .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px;}
        .card{background:white;padding:15px;border-radius:8px;box-shadow:0 2px 5px rgba(0,0,0,0.1);}
        .comparison{display:flex;align-items:center;justify-content:space-between;margin-top:10px;background:#fff;padding:10px;border-radius:4px;border:1px solid #eee;}
        /* Force display at 24px to verify sizing */
        img,svg{width:24px;height:24px;object-fit:contain;border:1px solid #ccc;background:url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAIklEQVQIW2NkQAKrVq36zwjjgzjwqkJymiA8VAQDQwMcAAw4E01j6k52AAAAAElFTkSuQmCC') repeat;}
        .hex-chip{display:inline-block;width:10px;height:10px;margin-right:4px;border:1px solid #ccc;}
        .label{font-size:11px;color:#666;text-align:center;margin-top:5px;}
    </style></head><body><h1>Final Production Audit</h1><div class="grid">`;

    for (const file of files) {
        const inputPath = path.join(LOGO_DIR, file);
        const outputName = file.replace(/\.[^/.]+$/, "") + ".svg";
        const outputPath = path.join(LOGO_DIR, outputName);

        try {
            console.log(`Processing: ${file}...`);
            const colors = await convertToHighFidelity(inputPath, outputPath);
            
            htmlContent += `
            <div class="card">
                <strong>${file}</strong><br>
                <div style="margin-bottom:5px">${colors.map(c => `<span class="hex-chip" style="background:${c}"></span>`).join('')}</div>
                <div class="comparison">
                    <div><img src="${file}" style="width:64px;height:64px;"><div class="label">Original</div></div>
                    <div><img src="${outputName}"><div class="label">Vector (24px)</div></div>
                </div>
            </div>`;
        } catch (err) {
            console.warn(`⚠️ Error ${file}: ${err.message}`);
        }
    }
    fs.writeFileSync(path.join(LOGO_DIR, 'audit.html'), htmlContent + `</div></body></html>`);
    console.log(`\n✅ Batch complete. Open audit.html to verify.`);
}

async function convertToHighFidelity(inputPath, outputPath) {
    const rawImage = sharp(inputPath).trim();
    
    // 1. FORCE SQUARE CANVAS (Fixes 24x24 sizing issues)
    // We create a 256x256 transparent square and center the logo inside it.
    const { data, info } = await rawImage
        .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    // 2. Color Analysis
    const colorCounts = {};
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];

        if (a < 128) continue; // Skip transparent
        // STRICTER FILTER: Ignore anything lighter than light grey (220)
        if (r > 220 && g > 220 && b > 220) continue; 

        const hex = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
        colorCounts[hex] = (colorCounts[hex] || 0) + 1;
    }

    let sortedColors = Object.keys(colorCounts)
        .sort((a, b) => colorCounts[b] - colorCounts[a])
        .slice(0, 3);
    
    if (sortedColors.length === 0) sortedColors = ['#000000'];

    let svgLayers = '';

    // 3. Multi-Layer Trace
    for (const color of sortedColors) {
        const rT = parseInt(color.slice(1, 3), 16);
        const gT = parseInt(color.slice(3, 5), 16);
        const bT = parseInt(color.slice(5, 7), 16);

        // A. Masking
        const maskPixels = Buffer.alloc(info.width * info.height * 4);
        for (let i = 0; i < info.width * info.height; i++) {
            const idx = i * 4;
            const alpha = data[idx+3];

            // Force transparency to WHITE (Paper)
            if (alpha < 128) {
                maskPixels[idx] = maskPixels[idx+1] = maskPixels[idx+2] = 255; 
                maskPixels[idx+3] = 255;
                continue;
            }

            const dist = Math.sqrt(
                Math.pow(data[idx]-rT,2) + 
                Math.pow(data[idx+1]-gT,2) + 
                Math.pow(data[idx+2]-bT,2)
            );

            // Stricter Threshold: < 50 prevents picking up noise
            const val = dist < 50 ? 0 : 255; 
            
            maskPixels[idx] = val;    
            maskPixels[idx+1] = val;   
            maskPixels[idx+2] = val;   
            maskPixels[idx+3] = 255; 
        }

        // B. File System Bypass (Fixes "Bitmap" Error)
        const tempFileName = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.png`;
        const tempFilePath = path.join(LOGO_DIR, tempFileName);

        await sharp(maskPixels, {
            raw: { width: info.width, height: info.height, channels: 4 }
        }).png().toFile(tempFilePath);

        // C. Trace & "Box Killer"
        const layerPath = await new Promise((resolve) => {
            potrace.trace(tempFilePath, { turdSize: 5, optTolerance: 0.2 }, (err, svg) => {
                try { fs.unlinkSync(tempFilePath); } catch(e) {} // Clean up

                if (err) return resolve('');

                // BOX KILLER: We inspect the bounding box of the path.
                // Potrace paths are just "d" attributes. We check if they start at 0,0 and end at 256,256
                // (Simplified here: We remove paths that are just gigantic rectangles)
                const paths = svg.match(/d="[^"]+"/g) || [];
                
                const validPaths = paths.filter(p => {
                    // Quick heuristic: If path string is very short (simple rect) AND covers huge area, skip it.
                    // Or more robustly: check if it's the "background" box Potrace sometimes adds.
                    // The standard Potrace background box usually starts with "M0 0..."
                    return !p.includes("M0 0") && !p.includes("M0,0");
                });

                if (validPaths.length === 0) return resolve('');
                resolve(`<path ${validPaths.join(' ')} fill="${color}" fill-rule="evenodd" />`);
            });
        });
        svgLayers += layerPath;
    }

    // 4. Final Assembly (Native 24x24 Scaling)
    // We wrap the 256x256 content in a group scaled by (24/256 = 0.09375)
    // This forces the coordinates to be native 24px coordinates.
    const fullSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
        <g transform="scale(0.09375)">
            ${svgLayers}
        </g>
    </svg>`;
    
    // We skip SVGO 'removeDimensions' to FORCE width/height=24
    const result = optimize(fullSvg, {
        multipass: true,
        plugins: [
            { name: 'removeViewBox', active: false }, // Keep our custom viewBox
            { name: 'removeDimensions', active: false } // Keep our custom width/height
        ]
    });

    fs.writeFileSync(outputPath, result.data);
    return sortedColors;
}

processAllLogos();