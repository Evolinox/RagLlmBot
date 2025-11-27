import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
const fs = require("fs");
const path = require("path");
import { PDFParse } from 'pdf-parse';

interface PluginSettings {
	llmModel: string;
	embeddingModel: string;
	basePrompt: string;
	chromaBaseUrl: string;
	chromaTenantName: string;
	chromaDatabaseName: string;
	chromaCollectionName: string;
	chromaCollectionId: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	llmModel: 'llama3.1',
	embeddingModel: 'qwen3-embedding',
	basePrompt: "You are an AI tutor. Based on the following material, generate a bunch of concise learning questions formatted in Markdown. Add the right solutions to an extra chapter at the bottom. All Questions should be answered only with the given material, don't ask, what may be in mentioned sources.",
	chromaBaseUrl: "http://localhost:9000",
	chromaTenantName: "obsidian_ragllmbot",
	chromaDatabaseName: "obsidian_db",
	chromaCollectionName: "obsidian_collection",
	chromaCollectionId: "",
}

export default class RagLLmBotPlugin extends Plugin {
	settings: PluginSettings;

	async onload() {
		console.log('RagLLmBotPlugin.onload');
		PDFParse.setWorker('https://cdn.jsdelivr.net/npm/pdf-parse@latest/dist/pdf-parse/web/pdf.worker.mjs');
		await this.loadSettings();

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'create-learning-questions',
			name: 'Create an Example Exam',
			callback: async () => {
				new PromptEngineeringModal(this.app, async (userPrompt) => {
					const activeFile = this.app.workspace.getActiveFile();
					if (!activeFile) {
						new Notice("No active file selected. Please select one");
						return;
					}
					const folderPath = path.dirname(activeFile.path);
					const vault = this.app.vault;

					const files = vault.getFiles().filter(
						(f) =>
							f.parent?.path === folderPath &&
							(f.extension === "md" || f.extension === "pdf")
					);

					let allText = "";
					new Notice(`Reading ${files.length} files in ${folderPath}...`);

					for (const file of files) {
						try {
							if (file.extension === "md") {
								const content = await vault.read(file);
								allText += `\n\n# ${file.name}\n${content}`;
							} else if (file.extension === "pdf") {
								const absPath = path.join((vault.adapter as any).basePath, file.path);
								const buffer = fs.readFileSync(absPath);
								const parser = new PDFParse({ data: buffer });
								const textResult = await parser.getText();
								await parser.destroy();
								allText += `\n\n# ${file.name}\n${textResult.text}`;
							}
						} catch (err) {
							console.error(`Error reading ${file.path}:`, err);
						}
					}

					// Create new file and open it
					const now = new Date();
					const date = now.toISOString().split("T")[0]; // yyyy-mm-dd
					const time = now
						.toTimeString()
						.split(" ")[0]
						.replace(/:/g, "_"); // hh_mm_ss → we'll keep hh_mm

					const filename = `${folderPath}/RagLlmLearning_${date}_${time.slice(0, 5)}.md`;
					const fileContent = `
---

**Prompt:** ${this.settings.basePrompt}

**User Details:** ${userPrompt}

---

`
					const newFile = await vault.create(filename, fileContent);
					await this.app.workspace.openLinkText(newFile.path, "", true);

					// Chroma DB Setup
					await this.checkTenant.call(this, this.settings.chromaTenantName);
					await this.checkDatabase.call(this, this.settings.chromaTenantName, this.settings.chromaDatabaseName);
					await this.checkCollection.call(this, this.settings.chromaTenantName, this.settings.chromaDatabaseName, this.settings.chromaCollectionName);

					const chunks = this.chunkText(allText);
					const chunkObjects: {id: string, text: string, embedding: number[]}[] = [];

					// Generate embeddings using your LLM or a service
					for (let i = 0; i < chunks.length; i++) {
						const chunk = chunks[i];
						const embeddingResponse = await fetch("http://localhost:11434/api/embed", {
							method: "POST",
							headers: {"Content-Type": "application/json"},
							body: JSON.stringify({ model: this.settings.embeddingModel, input: chunk })
						}).then(r => r.json());
						const embedding = Array.isArray(embeddingResponse.embeddings[0]) ? embeddingResponse.embeddings[0] : embeddingResponse.embeddings;
						if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every(n => typeof n === "number")) {
							throw new Error(`Invalid embedding for chunk ${i}`);
						}
						chunkObjects.push({ id: `chunk_${i}`, text: chunk, embedding });
					}
					await this.upsertChunksToCollection.call(this, this.settings.chromaTenantName, this.settings.chromaDatabaseName, this.settings.chromaCollectionName, this.settings.chromaCollectionId, chunkObjects);
					new Notice(`Stored ${chunks.length} chunks in ChromaDB for RAG.`);

					// Generate embedding for user prompt
					const userEmbeddingResponse = await fetch("http://localhost:11434/api/embed", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ model: this.settings.embeddingModel, input: userPrompt })
					}).then(r => r.json());

					const userEmbedding = Array.isArray(userEmbeddingResponse.embeddings[0])
						? userEmbeddingResponse.embeddings[0]
						: userEmbeddingResponse.embeddings;

					// Query Chroma
					const retrieved = await this.chromaApi.call(
						this,
						"POST",
						`/api/v2/tenants/${this.settings.chromaTenantName}/databases/${this.settings.chromaDatabaseName}/collections/${this.settings.chromaCollectionId}/query`,
						{
							n_results: 5, // number of chunks to retrieve
							query_embeddings: [userEmbedding]
						}
					);

					const contextText = retrieved.documents[0];

					const ragPrompt = `
${this.settings.basePrompt}

The user may have provided extra information:
${userPrompt}

Context retrieved from files:
---
${contextText}
`;
					const response = await fetch("http://localhost:11434/api/generate", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							model: this.settings.llmModel,
							prompt: ragPrompt,
							stream: true,
						}),
					});

					const reader = response.body?.getReader();
					const decoder = new TextDecoder("utf-8");

					let partial = "";
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						partial += decoder.decode(value, { stream: true });
						const lines = partial.split("\n");
						partial = lines.pop()!;
						for (const line of lines) {
							if (!line.trim()) continue;
							try {
								const data = JSON.parse(line);
								if (data.response) {
									await this.app.vault.adapter.append(newFile.path, data.response);
								}
							} catch (err) {
								console.warn("Stream parse error:", err);
							}
						}
					}
				}).open();
			}
		})

		// This adds a settings tab so the user can configure some aspects of the plugin
		this.addSettingTab(new RagLlmBotSettingTab(this.app, this));
	}

	onunload() {
		console.log('RagLLmBotPlugin.onunload');
	}

	async loadSettings() {
		console.log('RagLLmBotPlugin.loadSettings');
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		console.log('RagLLmBotPlugin.saveSettings');
		await this.saveData(this.settings);
	}

	async chromaApi(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		body?: any
	) {
		const baseUrl = this.settings.chromaBaseUrl || "http://localhost:8000"; // ChromaDB base
		const headers: Record<string, string> = { "Content-Type": "application/json" };

		const response = await fetch(`${baseUrl}${path}`, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Chroma API error (${response.status}): ${text}`);
		}
		return response.json();
	}

	async checkTenant(tenantName: string) {
		try {
			await this.chromaApi.call(this, "GET", `/api/v2/tenants/${tenantName}`);
			new Notice(`ChromaDB tenant exists: ${tenantName}`);
		} catch (err: any) {
			if (err.message.includes("404")) {
				await this.chromaApi.call(this, "POST", "/api/v2/tenants", { name: tenantName });
				new Notice(`Created ChromaDB tenant: ${tenantName}`);
			} else {
				console.error("Error checking tenant:", err);
				throw err; // rethrow for unexpected errors
			}
		}
	}

	async checkDatabase(tenantName: string, dbName: string) {
		try {
			const dbs = await this.chromaApi.call(
				this,
				"GET",
				`/api/v2/tenants/${tenantName}/databases`
			);
			if (!dbs.some((db: any) => db.name === dbName)) {
				await this.chromaApi.call(this, "POST", `/api/v2/tenants/${tenantName}/databases`, {
					name: dbName,
				});
				new Notice(`Created database: ${dbName} in tenant ${tenantName}`);
			}
		} catch (err) {
			console.error("Error ensuring database:", err);
		}
	}

	async checkCollection(tenantName: string, dbName: string, collectionName: string) {
		try {
			// Get list of collections
			const collections = await this.chromaApi.call(
				this,
				"GET",
				`/api/v2/tenants/${tenantName}/databases/${dbName}/collections`
			);

			// Check if collection exists
			let collection = collections.find((c: any) => c.name === collectionName);

			// If not, create it
			if (!collection) {
				collection = await this.chromaApi.call(
					this,
					"POST",
					`/api/v2/tenants/${tenantName}/databases/${dbName}/collections`,
					{ name: collectionName }
				);
				new Notice(`Created collection: ${collectionName} in database ${dbName}`);
			}

			// Store collection ID in settings
			if (collection?.id) {
				this.settings.chromaCollectionId = collection.id;
				await this.saveSettings(); // Make sure you save settings
				console.log(`Stored collection ID in settings: ${collection.id}`);
			} else {
				console.warn(`Collection ${collectionName} exists but has no ID`);
			}
		} catch (err) {
			console.error("Error ensuring collection:", err);
		}
	}

	async upsertChunksToCollection(
		tenantName: string,
		dbName: string,
		collectionName: string,
		collectionId: string,
		chunks: { id: string; text: string; embedding: number[] }[]
	) {
		if (!chunks || chunks.length === 0) return;

		// Validate embeddings
		for (const c of chunks) {
			if (!Array.isArray(c.embedding) || c.embedding.length === 0 || !c.embedding.every(n => typeof n === "number")) {
				throw new Error(`Invalid embedding for chunk ${c.id}`);
			}
		}

		const payload = {
			documents: chunks.map(c => c.text),
			embeddings: chunks.map(c => c.embedding),
			ids: chunks.map(c => c.id),
			metadatas: chunks.map(() => null),
			uris: chunks.map(() => ""),
		};

		await this.chromaApi.call(
			this,
			"POST",
			`/api/v2/tenants/${tenantName}/databases/${dbName}/collections/${collectionId}/add`,
			payload
		);

		new Notice(`Upserted ${chunks.length} chunks to collection ${collectionName}`);
	}

	chunkText(text: string, size = 500, overlap = 50): string[] {
		const chunks: string[] = [];
		let start = 0;
		while (start < text.length) {
			const end = Math.min(start + size, text.length);
			chunks.push(text.slice(start, end));
			start += size - overlap;
		}
		return chunks;
	}
}

class PromptEngineeringModal extends Modal {
	constructor(app: App, onSubmit: (result: string) => void) {
		super(app);
		this.setTitle("Additional Details");
		this.setContent("You can add additional details, that will be added to the prompt for the llm! The currently selected file and its directory will be automatically be added as context.");
		let userPrompt = '';
		new Setting(this.contentEl)
			.addTextArea((text) => {
				text.inputEl.style.width = '100%';
				text.inputEl.style.boxSizing = 'border-box';
				text.inputEl.style.minHeight = '120px';
				text.setPlaceholder("Your extra details...")
				text.onChange((value) => {
					userPrompt = value;
				});
			});
		const lastSetting = this.contentEl.querySelector(".setting-item:last-child") as HTMLElement;
		if (lastSetting) {
			lastSetting.style.flexDirection = "column";
			lastSetting.style.alignItems = "stretch";
		}
		new Setting(this.contentEl)
			.addButton((btn) =>
			btn.setButtonText('Submit')
				.setCta()
				.onClick(() => {
					console.log('PromptEngineeringModal.onSubmit');
					this.close();
					onSubmit(userPrompt);
				}));
	}

	onOpen() {
		console.log('PromptEngineeringModal.onOpen');
	}
}

class RagLlmBotSettingTab extends PluginSettingTab {
	plugin: RagLLmBotPlugin;

	constructor(app: App, plugin: RagLLmBotPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		const titleEl = containerEl.createEl('h1', { text: "RAG LLM Bot Settings"})
		titleEl.style.marginBottom = '0.5em';

		const descEl = containerEl.createEl('div', { text: "Configure RAG and LLM Settings. You can adjust prompts, enable features, etc."})
		descEl.style.marginBottom = '1em';
		descEl.style.fontSize = '0.9em';
		descEl.style.color = 'var(--text-muted)';

		new Setting(containerEl)
			.setName('LLM Model')
			.setDesc('Set LLM Model used by Ollama in the Background')
			.addText(text => text
				.setPlaceholder('Enter a Model')
				.setValue(this.plugin.settings.llmModel)
				.onChange(async (value) => {
					this.plugin.settings.llmModel = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Embedding Model')
			.setDesc('Set Embedding Model used by Ollama in the Background')
			.addText(text => text
				.setPlaceholder('Enter a Model')
				.setValue(this.plugin.settings.embeddingModel)
				.onChange(async (value) => {
					this.plugin.settings.embeddingModel = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('ChromaDB URL')
			.setDesc('Set URL for ChromaDB')
			.addText(text => text
				.setPlaceholder('Enter a URL')
				.setValue(this.plugin.settings.chromaBaseUrl)
				.onChange(async (value) => {
					this.plugin.settings.chromaBaseUrl = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('ChromaDB Tenant Name')
			.setDesc('Set Tenant Name for ChromaDB')
			.addText(text => text
				.setPlaceholder('Enter a Name')
				.setValue(this.plugin.settings.chromaTenantName)
				.onChange(async (value) => {
					this.plugin.settings.chromaTenantName = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('ChromaDB Database Name')
			.setDesc('Set Database Name for ChromaDB')
			.addText(text => text
				.setPlaceholder('Enter a Name')
				.setValue(this.plugin.settings.chromaDatabaseName)
				.onChange(async (value) => {
					this.plugin.settings.chromaDatabaseName = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('ChromaDB Collection Name')
			.setDesc('Set Collection Name for ChromaDB')
			.addText(text => text
				.setPlaceholder('Enter a Name')
				.setValue(this.plugin.settings.chromaCollectionName)
				.onChange(async (value) => {
					this.plugin.settings.chromaCollectionName = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Prompt')
			.setDesc('Set Prompt used by Ollama in the Background, can later be enriched by Modal')
			.addTextArea((text) => {
				text.setPlaceholder(
					'You are an AI Tutor, create 20 Questions with the given context. The Questions should be in following formats: Multiple Choice, Explaining, Calculating'
				);
				text.setValue(this.plugin.settings.basePrompt);

				// Style the textarea
				text.inputEl.style.width = '100%';
				text.inputEl.style.boxSizing = 'border-box';
				text.inputEl.style.minHeight = '120px';

				text.onChange(async (value) => {
					this.plugin.settings.basePrompt = value;
					await this.plugin.saveSettings();
				});
			});
		const lastSetting = containerEl.querySelector('.setting-item:last-child') as HTMLElement;
		if (lastSetting) {
			lastSetting.style.flexDirection = 'column';
			lastSetting.style.alignItems = 'stretch';
		}

	}
}
