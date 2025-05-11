/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { createSchema, createYoga } from 'graphql-yoga';
import OpenAI from 'openai'; // 导入 OpenAI 库

// 定义环境变量接口，包含 DeepSeek API Key
export interface Env {
	// Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
	// MY_KV_NAMESPACE: KVNamespace;
	//
	// Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
	// MY_DURABLE_OBJECT: DurableObjectNamespace;
	//
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	// MY_BUCKET: R2Bucket;
	//
	// Example binding to a Service. Learn more at https://developers.cloudflare.com/workers/runtime-apis/service-bindings/
	// MY_SERVICE: Fetcher;
	//
	// Example binding to a Queue. Learn more at https://developers.cloudflare.com/queues/javascript-apis/
	// MY_QUEUE: Queue;

	DEEPSEEK_API_KEY: string; // **重要：在 Cloudflare Worker 设置中添加这个环境变量**
}

const yoga = createYoga<Env>({
	// 将 Env 类型传递给 createYoga
	schema: createSchema({
		typeDefs: /* GraphQL */ `
			type PokemonSprites {
				front_default: String!
				front_shiny: String!
				front_female: String!
				front_shiny_female: String!
				back_default: String!
				back_shiny: String!
				back_female: String!
				back_shiny_female: String!
			}

			type Pokemon {
				id: ID!
				name: String!
				height: Int!
				weight: Int!
				sprites: PokemonSprites!
			}

			type Query {
				pokemon(id: ID!): Pokemon
				# 新增一个查询字段，用于调用 DeepSeek API
				askDeepseek(prompt: String!): String
			}
		`,
		resolvers: {
			Query: {
				// 原来的 pokemon resolver
				pokemon: async (_parent, { id }) => {
					const result = await fetch(new Request(`https://pokeapi.co/api/v2/pokemon/${id}`), {
						cf: {
							// Always cache this fetch regardless of content type
							// for a max of 1 min before revalidating the resource
							cacheTtl: 50,
							cacheEverything: true,
						},
					});
					// 检查请求是否成功
					if (!result.ok) {
						throw new Error(`Failed to fetch Pokemon ${id}: ${result.statusText}`);
					}
					return await result.json();
				},

				// 新增 askDeepseek resolver
				askDeepseek: async (_parent, { prompt }) => {
					// 从 context 中获取 env
					const deepseekApiKey = 'sk-3fdd42ec8d904836aeb48ff8cd353787';

					if (!deepseekApiKey) {
						// 如果 API Key 未设置，抛出错误
						throw new Error('DeepSeek API Key not configured in environment variables.');
					}
					try {
						// DeepSeek API 请求
						const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
							method: 'POST',
							headers: {
								'Content-Type': 'application/json',
								Authorization: `Bearer ${deepseekApiKey}`, // 替换为你的 DeepSeek API Key
							},
							body: JSON.stringify({
								model: 'deepseek-chat',
								messages: [{ role: 'user', content: prompt }],
								temperature: 0.7,
								max_tokens: 1000,
							}),
						});

						const data:any = await response.json();
						
						// 检查账户余额错误
						if (data.error && data.error.message === 'Insufficient Balance') {
							return '账户余额不足，请充值后再试。';
						}
						// 检查请求错误
						if (data.error) {
							return data.error.message;
						}
						// 返回 DeepSeek 的回答
						if (data.choices && data.choices[0]) {
							return data.choices[0].message.content.trim();
						}
						// 如果没有找到答案，返回默认消息
						return '对不起，我无法回答这个问题。请稍后再试。';
					} catch (error:any) {
						throw new Error(`DeepSeek API error: ${error.message}`);
					}
					try {
						// 初始化 OpenAI 客户端，使用 DeepSeek 的 baseURL 和 API Key
						const openai = new OpenAI({
							baseURL: 'https://api.deepseek.com', // DeepSeek 的推荐 baseURL 是 /v1
							apiKey: deepseekApiKey,
						});

						// 调用 chat completion API
						const completion = await openai.chat.completions.create({
							messages: [
								{ role: 'system', content: prompt }, // 使用 GraphQL 查询中传入的 prompt
							],
							model: 'deepseek-chat', // 或 deepseek-coder
							// 可以根据需要添加其他参数，例如 temperature, max_tokens 等
						});

						// 检查响应结构并返回内容
						if (completion.choices && completion.choices.length > 0 && completion.choices[0].message) {
							return completion.choices[0].message.content;
						} else {
							console.error('Unexpected DeepSeek response structure:', completion);
							return 'Error: Could not get a valid response from DeepSeek.';
						}
					} catch (error: any) {
						console.error('DeepSeek API error:', error);
						// 抛出错误，GraphiQL 或客户端会接收到
						throw new Error(`Failed to get response from DeepSeek: ${error.message || error}`);
					}
				},
			},
		},
	}),
	graphiql: {
		defaultQuery: /* GraphQL */ `
			# Example PokeAPI Query
			query samplePokeAPIquery {
				pokemon: pokemon(id: 1) {
					id
					name
					height
					weight
					sprites {
						front_shiny
						back_shiny
					}
				}
			}

			# Example DeepSeek Query (Requires variable $prompt)
			query sampleDeepseekQuery($prompt: String!) {
				deepseekResponse: askDeepseek(prompt: $prompt)
			}
		`,
		// 可以在 GraphiQL 中设置默认变量，方便测试 DeepSeek Query
		defaultVariableEditorState: {
			mode: 'json',
			readOnly: false,
			value: JSON.stringify(
				{
					prompt: '请用中文介绍一下 Cloudflare Workers。',
				},
				null,
				2
			),
		},
	},
});

export default {
	// Worker 的 fetch 入口
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// 将 env 对象传递给 yoga.fetch，以便 resolver 可以访问环境变量
		return yoga.fetch(request, env);
	},
};
