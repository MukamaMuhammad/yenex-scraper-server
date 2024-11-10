import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import puppeteer from "puppeteer";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Browser } from "puppeteer";
import { executablePath } from "puppeteer";
import { JSDOM } from "jsdom";
import type { ConstructorOptions } from "jsdom";
import { openai } from "@ai-sdk/openai";
import OpenAI from "openai";
import { generateObject } from "ai";
import { z } from "zod";
import {
  ProductSchema,
  cleanContent,
  getProductName,
  scrapeSearchResults,
  scrapeUrl,
  searchGoogle,
  selectBestImageWithVision,
  summarizeContent,
} from "./lib/functions";

puppeteerExtra.use(StealthPlugin());

const ProductInfoSchema = z.object({
  productName: z.string().describe("Name of the product"),
  watts: z.number().describe("Power rating of the product in watts"),
  volts: z.number().describe("Voltage of the product in volts"),
  amps: z.number().describe("Amperage of the product in amps"),
  url: z.string().url().describe("URL of the product page"),
});

interface PowerElement {
  text: string;
  originalText: string;
  element: Element;
}

dotenv.config();
const app = express();
const port = process.env.PORT || 3001;

const openaiReal = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// CORS configuration
const corsOptions: cors.CorsOptions = {
  origin: process.env.ALLOWED_ORIGINS?.split(",") || [],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  credentials: true,
  optionsSuccessStatus: 204,
  maxAge: 86400, // 24 hours
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(helmet());

// API Key middleware
const authenticateApiKey: express.RequestHandler = (req, res, next) => {
  const apiKey = req.get("X-API-Key");
  if (!apiKey || apiKey !== process.env.API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};

// Apply authentication middleware to all /api routes
app.use("/api", authenticateApiKey);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
});

// Apply rate limiting to all requests
app.use(limiter);

//@ts-ignore
app.post("/api/scrape", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  const browser: Browser = await puppeteer.launch({
    headless: true,
    executablePath: executablePath(),
  });
  console.log("Browser launched");
  const page = await browser.newPage();

  try {
    await page.setViewport({
      width: 1920,
      height: 1080,
    });

    // Increase the navigation timeout to 60 seconds
    // await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
    await page.goto(url, { waitUntil: "networkidle0", timeout: 100000 });

    // Add a delay after navigation to allow for any dynamic content to load
    await page.evaluate(
      () => new Promise((resolve) => setTimeout(resolve, 3000))
    );
    const content = await page.content();
    await browser.close();
    console.log("Content length:", content.length);

    // Use JSDOM for more advanced DOM manipulation
    let dom;
    try {
      dom = new JSDOM(content);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Could not parse CSS stylesheet")
      ) {
        console.warn(
          "CSS parsing error encountered, continuing without styles:",
          error.message
        );
        dom = new JSDOM(content, {
          features: { css: false },
        } as ConstructorOptions);
      } else {
        throw error;
      }
    }
    const document = dom.window.document;
    // Remove unnecessary elements
    const elementsToRemove = [
      "script",
      "style",
      "noscript",
      "iframe",
      "img",
      "video",
      "audio",
      "svg",
      "canvas",
      "map",
      "figure",
      "input",
      "textarea",
      "select",
      "button",
      "form",
      "footer",
      "nav",
      "aside",
    ];
    elementsToRemove.forEach((tag) => {
      document.querySelectorAll(tag).forEach((el) => el.remove());
    });

    // Remove comments
    const removeComments = (node: Node) => {
      for (let i = node.childNodes.length - 1; i >= 0; i--) {
        const child = node.childNodes[i];
        if (child.nodeType === 8) {
          node.removeChild(child);
        } else if (child.nodeType === 1) {
          removeComments(child);
        }
      }
    };
    removeComments(document.body);

    // Remove all attributes except 'class'
    document.querySelectorAll("*").forEach((el) => {
      Array.from(el.attributes).forEach((attr) => {
        if (attr.name !== "class") {
          el.removeAttribute(attr.name);
        }
      });
    });

    // Remove empty elements
    const removeEmptyElements = (node: Node) => {
      for (let i = node.childNodes.length - 1; i >= 0; i--) {
        const child = node.childNodes[i];
        if (child.nodeType === 1) {
          removeEmptyElements(child);
          if (
            (child as Element).innerHTML.trim() === "" &&
            !["br", "hr"].includes((child as Element).tagName.toLowerCase())
          ) {
            node.removeChild(child);
          }
        }
      }
    };
    removeEmptyElements(document.body);

    // Find elements containing power-related terms
    const powerTerms: string[] = [
      "watts",
      "w",
      "kwh",
      "kwhr",
      "kwhrs",
      "watt",
      "volt",
      "volts",
      "v",
      "amp",
      "amps",
      "a",
      "mA",
    ];
    const powerElements: PowerElement[] = [];

    // Function to get nth parent element
    const getNthParent = (
      element: Element | null,
      n: number
    ): Element | null => {
      let parent: Element | null = element;
      for (let i = 0; i < n && parent; i++) {
        parent = parent.parentElement;
      }
      return parent;
    };

    // Function to extract text from an element and its children
    const extractText = (element: Element | null): string => {
      return element
        ? element.textContent?.trim().replace(/\s+/g, " ") || ""
        : "";
    };

    // Function to check if there's a number near the power term
    const hasNumberNearTerm = (text: string, term: string): boolean => {
      // Look for numbers within 10 characters before or after the term
      const windowSize = 30;
      const termIndex = text.toLowerCase().indexOf(term);
      if (termIndex === -1) return false;

      const start = Math.max(0, termIndex - windowSize);
      const end = Math.min(text.length, termIndex + term.length + windowSize);
      const textWindow = text.slice(start, end);

      // Regular expression to match numbers (including decimals)
      const numberPattern = /\d+(?:\.\d+)?/;
      return numberPattern.test(textWindow);
    };

    // Function to validate power-related content
    const isValidPowerContent = (text: string): boolean => {
      const lowercaseText = text.toLowerCase();
      return powerTerms.some((term) => {
        const hasTerm = lowercaseText.includes(term);
        return hasTerm && hasNumberNearTerm(lowercaseText, term);
      });
    };

    // Search through all text nodes
    const walker = document.createTreeWalker(
      document.body,
      dom.window.NodeFilter.SHOW_TEXT
    );

    let node: Node | null = walker.currentNode;
    while ((node = walker.nextNode())) {
      const text = node.textContent || "";

      // Check if the text contains any power-related terms with nearby numbers
      if (isValidPowerContent(text)) {
        const parentElement = node.parentElement;
        if (parentElement) {
          const fifthParent = getNthParent(parentElement, 2);
          if (fifthParent) {
            const contextText = extractText(fifthParent);
            // Double-check the full context still contains valid power information
            if (isValidPowerContent(contextText)) {
              powerElements.push({
                text: contextText,
                originalText: text.trim(),
                element: fifthParent,
              });
            }
          }
        }
      }
    }

    // If no power ratings found, return an empty response instead of null
    if (powerElements.length === 0) {
      return JSON.stringify({ error: "No power ratings found" });
    }

    // Remove duplicates based on text content
    const uniquePowerElements = powerElements.filter(
      (element, index, self) =>
        index === self.findIndex((e) => e.text === element.text)
    );
    console.log("uniquePowerElements", uniquePowerElements);
    const uniquePowerElementsText = uniquePowerElements
      .map((e) => e.text)
      .join("\n");
    console.log("Cleaned content length:", uniquePowerElementsText.length);

    const result = await generateObject({
      model: openai("gpt-4o-mini"),
      schema: ProductInfoSchema,
      prompt: `
        Analyze the following HTML text content from a product page and extract the product name and power rating information (watts, volts, amps). Please read all power ratings in the provided text (e.g. kwh, kwhr, kwhrs,v, kv, a, amps, kamps etc.) before converting them to watts, volts, and amps accordingly.
        If the power ratings are not explicitly stated, make an educated guess based on similar products
        HTML text Content:
        ${uniquePowerElementsText}

        Provide the result in the following format:
        {
        "productName": "Name of the product",
        "powerRating": {
          "watts": Power rating in watts,
          "volts": Power rating in volts,
          "amps": Power rating in amps
        },
        "url": "${url}"
      }
      `,
    });
    console.log("result", result.object);
    res.json(result.object);
    // return result.toTextStreamResponse();
  } catch (error) {
    console.error("Error scraping webpage:", error);
    await browser.close();
    res.status(500).json({ error: "Internal server error" });
    throw error;
  } finally {
    await browser.close();
  }
});

// Add the new route before app.listen
app.post(
  "/api/product-scraper",
  async (req: Request<any, any, { url: string }>, res: Response) => {
    res.setTimeout(300000); // 5 minutes
    try {
      const { url } = req.body;
      if (!url) {
        res.status(400).json({ error: "URL is required" });
        return;
      }

      const initialContent = await scrapeUrl(url);
      if (!initialContent?.content) {
        throw new Error("Failed to scrape initial URL");
      }

      const cleanedContent = await cleanContent(initialContent.content);
      const productName = await getProductName(cleanedContent);
      const searchResults = await searchGoogle(productName);
      const limitedResults = searchResults.searchResults.slice(0, 7);

      const { contents, images } = await scrapeSearchResults(
        limitedResults,
        productName
      );
      const bestImage = await selectBestImageWithVision(
        images,
        productName,
        openaiReal
      );

      const summarizedContents = await Promise.all(
        contents.map((result) => summarizeContent(result.content))
      );

      const combinedDetails = summarizedContents
        .filter((summary) => typeof summary === "string" && summary.length > 0)
        .join("\n\n");

      const { object } = await generateObject({
        model: openai("gpt-4o-mini"),
        schema: ProductSchema,
        prompt: `
        Generate comprehensive product information for ${productName}.
        Use this summarized content and specifications from multiple sources:

        Content:
        ${combinedDetails}

        Generate a detailed response including:
        1. Product name and description.(Description should be a detailed description of the product)
        2. Ratings and reviews. (Should be related to the product)
        3. Where to buy information. (Include the retailer, country, price and url)
        4. Technical specifications as an array of label-value pairs
        5. Frequently asked questions. (Should be technical questions or related to the product specifications)

        Important: Format specifications as an array of objects with label and value properties.
        Ensure all specifications are included and all information is factual.
      `,
      });

      object.image = bestImage;
      res.json(object);
    } catch (error) {
      console.error("Error in product scraper:", error);
      res.status(500).json({
        error: "Failed to scrape product information",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

// Add error handling middleware
app.use((err: Error, req: Request, res: Response, next: Function) => {
  console.error("Error:", err);
  res.status(500).json({
    error: "Internal Server Error",
    message: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
