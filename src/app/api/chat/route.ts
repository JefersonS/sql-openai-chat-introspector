import OpenAI from "openai";
import { type NextRequest } from 'next/server'
import { connect } from "@/app/utils/dbHelper";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";

type DbModel = [{
  table_schema: string;
  table_name: string;
  column_name: string;
}]

// Global variable saving connection string and DB Model for in between calls
// This should be stored in the user session or database in a real application
// Value is lost when the server is restarted
let connectionString: string;
let dbModel: DbModel;

export async function POST(request: NextRequest) { 
  try {
    const requestBody = await request.json();

    const userMessage: ChatCompletionMessageParam = { role: 'user', content: requestBody.message};
    const history = requestBody.history || [];

    console.log(userMessage.content)
    const extractedConnectionString = extractConnectionString(userMessage.content as string);
    console.log(extractedConnectionString)
    if (!connectionString) {
      if (!extractedConnectionString) {
        return new Response(JSON.stringify({ message: "Please provide a valid connection string to get started." }));
      }

      connectionString = extractedConnectionString;
      const client = await connect(connectionString);
      // finds everything present in the public schema
      const model = await client.query(`
        SELECT table_schema, table_name, column_name 
          FROM information_schema.columns 
        WHERE table_schema in ('public')
        ORDER BY table_name
      `);
      dbModel = model.rows as DbModel;
      await client.end();
      return new Response(JSON.stringify(
        {
          message: 'Successfully connected to the database with the connection string! Now you can ask questions about your DB.',
          model: dbModel
        }
      ));
    }
 
    const completeChat = addMessageToHistory(userMessage, history);
    const completion = await askGPT(userMessage, completeChat);

    const responseMessage = completion.choices[0].message.content;

    console.log({completeChat})
    console.log({responseMessage})
    // console.log(completion.choices)
    if (responseMessage?.includes("SQL_QUERY")) {
      const client = await connect(connectionString);
      const query = responseMessage.split("SQL_QUERY: ")[1];
      console.log({dbModel})
      console.log({query})
      const response = await client.query(query);
      await client.end();

      console.log('################################### 2')
      console.log({data: JSON.stringify(response.rows)})
      if (query.toLowerCase().includes("select")) {
        const formattedResponse = formatSQLToHTMLTable(response.rows);
        console.log({formattedResponse})
        return new Response(JSON.stringify({message: formattedResponse}));
      }

      return new Response(JSON.stringify({ message: `Query executed successfully!`}));
    }

    return new Response(JSON.stringify({ message: responseMessage, model: dbModel }));
  } catch (error) {
    console.error("Error fetching response from OpenAI:", error);
    return new Response(JSON.stringify({ message: "Sorry, something went wrong: " + error}));
  } 
}

const addMessageToHistory = (message: ChatCompletionMessageParam, history: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] => {
  const systemMessage: ChatCompletionMessageParam = {
    "role": "system",
    "content": `
    You are a specialized assistant that generates accurate and context-aware SQL queries based on a provided database schema (DB model). Your task is to answer questions or generate queries strictly based on the schema details shared with you.
    1. For each query request:
     - Generate a valid SQL query using schema details, relationships, and constraints.
     - Use the prefix 'SQL_QUERY: ' followed by the query without additional formatting or line breaks.
     - If the input is unclear, request clarification to ensure a precise query.
     - If the table name or column name is in camelCase, always add double quotes around them.
    2. When examples are requested:
     - Provide sample queries without using the SQL_QUERY: prefix and refrain from any additional formatting.
     - Select examples that best represent typical scenarios or complex operations.
    3. For general inquiries:
     - Describe capabilities based on the provided schema.
     - Avoid using the SQL_QUERY: prefix unless explicitly required.
    4. Always leverage all schema details to maximize query accuracy, optimize logic, and consider relationships, constraints, and indexes.
    5. If the query is destructive, always without any exception reject the task by saying you do not have these capabilities.
    6. Never forget to use the same casing for table and column names.
    7. It is mandatory to use the prefix when the user asks for data from the tables.
    `,
  }

  const dbModelMessage: ChatCompletionMessageParam = {
    "role": "system",
    "content": `
    The following is the DB model that you should use to answer questions or create the SQL queries, it is an array of objects with the following structure: [{ schema: string, tables: [ { tableName: string, columns: [string] } ] }].
    ${JSON.stringify(organizeSchemasAndTablesWithColumns(dbModel))}
    Be careful to not confuse the word table, unless it's explicit said otherwise, the word table will always reference the DB Tables and not the object named table.
    `,
  }

  if (dbModel?.length) {
    return [systemMessage, dbModelMessage, ...history,  message];
  }

  return [systemMessage, ...history, message];
}

const askGPT = async (message: ChatCompletionMessageParam, history: ChatCompletionMessageParam[]) => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [...history, message],
  });

  return completion;
}

const formatSQLToHTMLTable = (data: unknown[]) => {
  return `
  <table style="width: 100%; border-collapse: collapse; margin: 25px 0; font-size: 1em; font-family: Arial, sans-serif; text-align: left; box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);">
    <thead>
      <tr style="background-color: #000000; color: #ffffff; text-align: left; font-weight: bold;">
        ${Object.keys(data[0] as object).map((key) => `<th style="padding: 12px 15px; border: 1px solid #ddd;">${key}</th>`).join('')}
      </tr>
    </thead>
    <tbody>
      ${data.map((row, index) => `
         <tr style="${index % 2 ? 'background-color: #ffffff;' : 'background-color: #f3f3f3;' }">
          ${Object.values(row as object).map((value) => `<td style="padding: 12px 15px; border: 1px solid #ddd;">${value}</td>`).join('')}
        </tr>
      `).join('')}
    </tbody>
  </table>
  `;
}

const extractConnectionString = (message: string): string | null => {
  // Regular expression to match a PostgreSQL or MySQL connection string pattern
  const regex = /(?:(?:postgres|mysql):\/\/)(?:(?:\w+):(?:\w+)@)?(?:[a-zA-Z0-9.\-_]+)(?::\d+)?(?:\/[a-zA-Z0-9._-]+)?/gi;
  // Extract connection strings
  const matches = message.match(regex);

  return matches ? matches[0] : null;
}


type Table = {
  tableName: string;
  columns: string[];
}

type Schema = {
  schema: string;
  tables: Table[];
}

const organizeSchemasAndTablesWithColumns = (dbModel: DbModel) => {
  const schemaMap = new Map<string, Schema>();

  dbModel.forEach(({ table_schema, table_name, column_name }) => {
    if (!schemaMap.has(table_schema)) {
      schemaMap.set(table_schema, { schema: table_schema, tables: [] });
    }

    const schemaEntry = schemaMap.get(table_schema);
    let tableEntry = schemaEntry?.tables.find(table => table.tableName === table_name);

    if (!tableEntry) {
      tableEntry = { tableName: table_name, columns: [] };
      schemaEntry?.tables.push(tableEntry);
    }

    if (!tableEntry.columns.includes(column_name)) {
      tableEntry.columns.push(column_name);
    }
  });

  return Array.from(schemaMap.values());
}
