AFRAME.registerComponent("gaussian_splatting", {
	schema: {
		src: {type: 'string', default: "train.splat"},
	},
	init: function () {
		this.el.sceneEl.renderer.setPixelRatio(1);

		fetch(this.data.src)
		.then((data) => data.blob())
		.then((res) => res.arrayBuffer())
		.then((buffer) => {
			let size = new THREE.Vector2();
			this.el.sceneEl.renderer.getSize(size);

			const focal = (size.y / 2.0) / Math.tan(this.el.sceneEl.camera.el.components.camera.data.fov / 2.0 * Math.PI / 180.0);

			const geometry = new THREE.PlaneGeometry( 4, 4);
			const material = new THREE.ShaderMaterial( {
				uniforms : {
					viewport: {value: new Float32Array([size.x, size.y])},
					focal: {value: focal}
				},
				vertexShader: `
					out vec4 vColor;
					out vec2 vPosition;
					uniform vec2 viewport;
					uniform float focal;

					void main () {
						vec4 center = vec4(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2], 1);
						// Adjust View Pose
						mat4 adjViewMatrix = inverse(viewMatrix);
						adjViewMatrix[0][1] *= -1.0;
						adjViewMatrix[1][0] *= -1.0;
						adjViewMatrix[1][2] *= -1.0;
						adjViewMatrix[2][1] *= -1.0;
						adjViewMatrix[3][1] *= -1.0;
						adjViewMatrix = inverse(adjViewMatrix);
						mat4 modelMatrix_fixy = modelMatrix;
						modelMatrix_fixy[3][1] *= -1.0;
						mat4 modelView = adjViewMatrix * modelMatrix_fixy;

						vec4 camspace = modelView * center;
						vec4 pos2d = projectionMatrix * mat4(1,0,0,0,0,-1,0,0,0,0,1,0,0,0,0,1) * camspace;

						float bounds = 1.2 * pos2d.w;
						if (pos2d.z < -pos2d.w || pos2d.x < -bounds || pos2d.x > bounds
							|| pos2d.y < -bounds || pos2d.y > bounds) {
							gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
							return;
						}

						mat3 J = mat3(
							focal / camspace.z, 0., -(focal * camspace.x) / (camspace.z * camspace.z), 
							0., -focal / camspace.z, (focal * camspace.y) / (camspace.z * camspace.z), 
							0., 0., 0.
						);

						mat3 W = transpose(mat3(modelView));
						mat3 T = W * J;
						mat3 cov = transpose(T) * mat3(instanceMatrix) * T;

						vec2 vCenter = vec2(pos2d) / pos2d.w;

						float diagonal1 = cov[0][0] + 0.3;
						float offDiagonal = cov[0][1];
						float diagonal2 = cov[1][1] + 0.3;

						float mid = 0.5 * (diagonal1 + diagonal2);
						float radius = length(vec2((diagonal1 - diagonal2) / 2.0, offDiagonal));
						float lambda1 = mid + radius;
						float lambda2 = max(mid - radius, 0.1);
						vec2 diagonalVector = normalize(vec2(offDiagonal, lambda1 - diagonal1));
						vec2 v1 = min(sqrt(2.0 * lambda1), 1024.0) * diagonalVector;
						vec2 v2 = min(sqrt(2.0 * lambda2), 1024.0) * vec2(diagonalVector.y, -diagonalVector.x);

						vColor = vec4(instanceMatrix[0][3], instanceMatrix[1][3], instanceMatrix[2][3], instanceMatrix[3][3]);
						vPosition = position.xy;

						gl_Position = vec4(
							vCenter 
								+ position.x * v2 / viewport * 2.0 
								+ position.y * v1 / viewport * 2.0, pos2d.z / pos2d.w, 1.0);
					}
					`,
				fragmentShader: `
					in vec4 vColor;
					in vec2 vPosition;

					void main () {
						float A = -dot(vPosition, vPosition);
						if (A < -4.0) discard;
						float B = exp(A) * vColor.a;
						gl_FragColor = vec4(vColor.rgb, B);
					}
				`,
				blending : THREE.CustomBlending,
				blendSrcAlpha : THREE.OneFactor,
				depthTest : true,
				depthWrite: false
			} );

			window.addEventListener('resize', () => {
				let size = new THREE.Vector2();
				this.el.sceneEl.renderer.getSize(size);
				const focal = (size.y / 2.0) / Math.tan(this.el.sceneEl.camera.el.components.camera.data.fov / 2.0 * Math.PI / 180.0);
				material.uniforms.viewport.value[0] = size.x;
				material.uniforms.viewport.value[1] = size.y;
				material.uniforms.focal.value = focal;
			});

			let u_buffer = new Uint8Array(buffer);
			if (
				u_buffer[0] == 112 &&
				u_buffer[1] == 108 &&
				u_buffer[2] == 121 &&
				u_buffer[3] == 10
			) {
				buffer = this.processPlyBuffer(buffer);
				u_buffer = new Uint8Array(buffer);
			}

			const rowLength = 3 * 4 + 3 * 4 + 4 + 4;
			let vertexCount = Math.floor(buffer.byteLength / rowLength);
			let f_buffer = new Float32Array(buffer);

			let matrices = new Float32Array(vertexCount * 16);
			for (let i = 0; i < vertexCount; i++) {
				let quat = new THREE.Quaternion(
					(u_buffer[32 * i + 28 + 1] - 128) / 128.0,
					(u_buffer[32 * i + 28 + 2] - 128) / 128.0,
					-(u_buffer[32 * i + 28 + 3] - 128) / 128.0,
					(u_buffer[32 * i + 28 + 0] - 128) / 128.0,
				);
				let center = new THREE.Vector3(
					f_buffer[8 * i + 0],
					f_buffer[8 * i + 1],
					-f_buffer[8 * i + 2]
				);
				let scale = new THREE.Vector3(
					f_buffer[8 * i + 3 + 0],
					f_buffer[8 * i + 3 + 1],
					f_buffer[8 * i + 3 + 2]
				);

				let mtx = new THREE.Matrix4();
				mtx.makeRotationFromQuaternion(quat);
				mtx.transpose();
				mtx.scale(scale);
				let mtx_t = mtx.clone()
				mtx.transpose();
				mtx.premultiply(mtx_t);
				mtx.setPosition(center);

				// RGBA
				mtx.elements[3] = u_buffer[32 * i + 24 + 0] / 255;
				mtx.elements[7] = u_buffer[32 * i + 24 + 1] / 255;
				mtx.elements[11] = u_buffer[32 * i + 24 + 2] / 255;
				mtx.elements[15] = u_buffer[32 * i + 24 + 3] / 255;

				for(let j = 0; j < 16; j++){
					matrices[i * 16 + j] = mtx.elements[j];
				}
			}

			const camera_mtx = this.el.sceneEl.camera.el.object3D.matrixWorld.elements;
			let view = new Float32Array([camera_mtx[2], camera_mtx[6], camera_mtx[10]]);
			this.iMesh = new THREE.InstancedMesh(geometry, material, vertexCount);
			this.iMesh.frustumCulled = false;
			this.iMesh.instanceMatrix.array = this.sortSplats(matrices, view);
			this.iMesh.instanceMatrix.needsUpdate = true;
			this.el.object3D.add(this.iMesh);

			this.worker = new Worker(
				URL.createObjectURL(
					new Blob(["(", this.createWorker.toString(), ")(self)"], {
						type: "application/javascript",
					}),
				),
			);

			this.worker.postMessage({
				sortFunction: this.sortSplats.toString(),
				matrices:matrices.buffer
			}, [matrices.buffer]);

			this.worker.onmessage = (e) => {
				this.iMesh.instanceMatrix.array = new Float32Array(e.data.sortedMatrices);
				this.iMesh.instanceMatrix.needsUpdate = true;
				this.sortReady = true;
			};
			this.sortReady = true;
		});
	},
	tick: function(time, timeDelta) {
		if(this.sortReady){
			this.sortReady = false;
			const camera_mtx = this.el.sceneEl.camera.el.object3D.matrixWorld.elements;
			let view = new Float32Array([camera_mtx[2], camera_mtx[6], camera_mtx[10]]);
			this.worker.postMessage({view}, [view.buffer]);
		}
	},
	createWorker: function (self) {
		let sortFunction;
		let matrices;
		self.onmessage = (e) => {
			if(e.data.sortFunction){
				eval(e.data.sortFunction);
				sortFunction = sortSplats;
			}
			if(e.data.matrices){
				matrices = new Float32Array(e.data.matrices);
			}
			if(e.data.view){
				const view = new Float32Array(e.data.view);	
				const sortedMatrices = sortFunction(matrices, view);
				self.postMessage({sortedMatrices}, [sortedMatrices.buffer]);
			}
		};
	},
	sortSplats: function sortSplats(matrices, view){
		const vertexCount = matrices.length/16;
	
		let maxDepth = -Infinity;
		let minDepth = Infinity;
		let depthList = new Float32Array(vertexCount);
		let sizeList = new Int32Array(depthList.buffer);
		for (let i = 0; i < vertexCount; i++) {
			let depth =
				-((view[0] * matrices[i * 16 + 12] -
					view[1] * matrices[i * 16 + 13] -
					view[2] * matrices[i * 16 + 14]));
			depthList[i] = depth;
			if (depth > maxDepth) maxDepth = depth;
			if (depth < minDepth) minDepth = depth;
		}
	
		// This is a 16 bit single-pass counting sort
		let depthInv = (256 * 256 - 1) / (maxDepth - minDepth);
		let counts0 = new Uint32Array(256*256);
		for (let i = 0; i < vertexCount; i++) {
			sizeList[i] = ((depthList[i] - minDepth) * depthInv) | 0;
			counts0[sizeList[i]]++;
		}
		let starts0 = new Uint32Array(256*256);
		for (let i = 1; i < 256*256; i++) starts0[i] = starts0[i - 1] + counts0[i - 1];
		let depthIndex = new Uint32Array(vertexCount);
		for (let i = 0; i < vertexCount; i++) depthIndex[starts0[sizeList[i]]++] = i;
	
		let sortedMatrices = new Float32Array(vertexCount * 16);
		for (let j = 0; j < vertexCount; j++) {
			let i = depthIndex[j];
			for(let k = 0; k < 16; k++){
				sortedMatrices[j * 16 + k] = matrices[i * 16 + k];
			}
		}
	
		return sortedMatrices;
	},
	processPlyBuffer: function (inputBuffer) {
		const ubuf = new Uint8Array(inputBuffer);
		// 10KB ought to be enough for a header...
		const header = new TextDecoder().decode(ubuf.slice(0, 1024 * 10));
		const header_end = "end_header\n";
		const header_end_index = header.indexOf(header_end);
		if (header_end_index < 0)
			throw new Error("Unable to read .ply file header");
		const vertexCount = parseInt(/element vertex (\d+)\n/.exec(header)[1]);
		console.log("Vertex Count", vertexCount);
		let row_offset = 0,
			offsets = {},
			types = {};
		const TYPE_MAP = {
			double: "getFloat64",
			int: "getInt32",
			uint: "getUint32",
			float: "getFloat32",
			short: "getInt16",
			ushort: "getUint16",
			uchar: "getUint8",
		};
		for (let prop of header
			.slice(0, header_end_index)
			.split("\n")
			.filter((k) => k.startsWith("property "))) {
			const [p, type, name] = prop.split(" ");
			const arrayType = TYPE_MAP[type] || "getInt8";
			types[name] = arrayType;
			offsets[name] = row_offset;
			row_offset += parseInt(arrayType.replace(/[^\d]/g, "")) / 8;
		}
		console.log("Bytes per row", row_offset, types, offsets);

		let dataView = new DataView(
			inputBuffer,
			header_end_index + header_end.length,
		);
		let row = 0;
		const attrs = new Proxy(
			{},
			{
				get(target, prop) {
					if (!types[prop]) throw new Error(prop + " not found");
					return dataView[types[prop]](
						row * row_offset + offsets[prop],
						true,
					);
				},
			},
		);

		console.time("calculate importance");
		let sizeList = new Float32Array(vertexCount);
		let sizeIndex = new Uint32Array(vertexCount);
		for (row = 0; row < vertexCount; row++) {
			sizeIndex[row] = row;
			if (!types["scale_0"]) continue;
			const size =
				Math.exp(attrs.scale_0) *
				Math.exp(attrs.scale_1) *
				Math.exp(attrs.scale_2);
			const opacity = 1 / (1 + Math.exp(-attrs.opacity));
			sizeList[row] = size * opacity;
		}
		console.timeEnd("calculate importance");

		console.time("sort");
		sizeIndex.sort((b, a) => sizeList[a] - sizeList[b]);
		console.timeEnd("sort");

		// 6*4 + 4 + 4 = 8*4
		// XYZ - Position (Float32)
		// XYZ - Scale (Float32)
		// RGBA - colors (uint8)
		// IJKL - quaternion/rot (uint8)
		const rowLength = 3 * 4 + 3 * 4 + 4 + 4;
		const buffer = new ArrayBuffer(rowLength * vertexCount);

		console.time("build buffer");
		for (let j = 0; j < vertexCount; j++) {
			row = sizeIndex[j];

			const position = new Float32Array(buffer, j * rowLength, 3);
			const scales = new Float32Array(buffer, j * rowLength + 4 * 3, 3);
			const rgba = new Uint8ClampedArray(
				buffer,
				j * rowLength + 4 * 3 + 4 * 3,
				4,
			);
			const rot = new Uint8ClampedArray(
				buffer,
				j * rowLength + 4 * 3 + 4 * 3 + 4,
				4,
			);

			if (types["scale_0"]) {
				const qlen = Math.sqrt(
					attrs.rot_0 ** 2 +
						attrs.rot_1 ** 2 +
						attrs.rot_2 ** 2 +
						attrs.rot_3 ** 2,
				);

				rot[0] = (attrs.rot_0 / qlen) * 128 + 128;
				rot[1] = (attrs.rot_1 / qlen) * 128 + 128;
				rot[2] = (attrs.rot_2 / qlen) * 128 + 128;
				rot[3] = (attrs.rot_3 / qlen) * 128 + 128;

				scales[0] = Math.exp(attrs.scale_0);
				scales[1] = Math.exp(attrs.scale_1);
				scales[2] = Math.exp(attrs.scale_2);
			} else {
				scales[0] = 0.01;
				scales[1] = 0.01;
				scales[2] = 0.01;

				rot[0] = 255;
				rot[1] = 0;
				rot[2] = 0;
				rot[3] = 0;
			}

			position[0] = attrs.x;
			position[1] = attrs.y;
			position[2] = attrs.z;

			if (types["f_dc_0"]) {
				const SH_C0 = 0.28209479177387814;
				rgba[0] = (0.5 + SH_C0 * attrs.f_dc_0) * 255;
				rgba[1] = (0.5 + SH_C0 * attrs.f_dc_1) * 255;
				rgba[2] = (0.5 + SH_C0 * attrs.f_dc_2) * 255;
			} else {
				rgba[0] = attrs.red;
				rgba[1] = attrs.green;
				rgba[2] = attrs.blue;
			}
			if (types["opacity"]) {
				rgba[3] = (1 / (1 + Math.exp(-attrs.opacity))) * 255;
			} else {
				rgba[3] = 255;
			}
		}
		console.timeEnd("build buffer");
		return buffer;
	}
});