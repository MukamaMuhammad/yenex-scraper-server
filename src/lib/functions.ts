import { openai } from "@ai-sdk/openai";
import { generateObject, generateText, streamObject } from "ai";
import { JSDOM } from "jsdom";
import type { ConstructorOptions } from "jsdom";
import { z } from "zod";
import puppeteer from "puppeteer";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Browser } from "puppeteer";
import { executablePath } from "puppeteer";

puppeteerExtra.use(StealthPlugin());

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface ProductImage {
  url: string;
  alt: string;
}

async function extractProductImage(
  page: any,
  productName: string
): Promise<ProductImage | null> {
  try {
    const images = await page.evaluate((productName: string) => {
      function calculateSimilarity(str1: string, str2: string): number {
        const s1 = str1.toLowerCase().replace(/[^a-z0-9\s]/g, "");
        const s2 = str2.toLowerCase().replace(/[^a-z0-9\s]/g, "");
        const words1 = new Set(s1.split(/\s+/));
        const words2 = new Set(s2.split(/\s+/));
        const commonWords = Array.from(words1).filter((word) =>
          words2.has(word)
        );
        return commonWords.length / Math.max(words1.size, words2.size);
      }

      const imageElements = Array.from(document.querySelectorAll("img"));
      const validImages = imageElements
        .map((img) => {
          const src =
            img.getAttribute("data-zoom-image") ||
            img.getAttribute("data-large-image") ||
            img.currentSrc ||
            img.src;
          const alt = img.alt || "";
          const width = img.naturalWidth || img.width;
          const height = img.naturalHeight || img.height;

          return {
            url: src,
            alt,
            width,
            height,
            similarity: calculateSimilarity(productName, alt),
          };
        })
        .filter((img) => {
          return (
            img.url &&
            !img.url.includes("data:image") &&
            !img.url.includes("blank.gif") &&
            !img.url.includes("placeholder") &&
            !img.url.includes("logo") &&
            Math.min(img.width, img.height) >= 200
          );
        })
        .sort((a, b) => b.similarity - a.similarity);

      return validImages[0] || null;
    }, productName);

    console.log("images", images);
    return images;
  } catch (error) {
    console.error("Error extracting product image:", error);
    return null;
  }
}

export const scrapeUrl = async (url: string, productName?: string) => {
  const isLocal = !!process.env.CHROME_EXECUTABLE_PATH;
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: executablePath(),
    });
    console.log("Browser launched");

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    });

    await page.goto(url, {
      timeout: 100000,
      waitUntil: ["domcontentloaded", "networkidle0"],
    });

    const content = await page.content();
    const image = productName
      ? await extractProductImage(page, productName)
      : null;

    await browser.close();
    return { content, image };
  } catch (error) {
    if (browser) await browser.close();
    throw error;
  }
};

export const cleanContent = async (content: string) => {
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

  // Extract and clean the text content
  const cleanedText =
    document.body.textContent?.trim().replace(/\s+/g, " ") || "";
  console.log("cleanedText length", cleanedText.length);
  return cleanedText;
};

export const searchGoogle = async (query: string) => {
  const isLocal = !!process.env.CHROME_EXECUTABLE_PATH;
  try {
    // Launch puppeteer with the same configuration as scrapeUrl
    const browser: Browser = await puppeteer.launch({
      headless: true,
      executablePath: executablePath(),
    });
    console.log("Browser launched");

    const page = await browser.newPage();

    // Set headers to avoid detection
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });

    await page.setViewport({ width: 1920, height: 1080 });

    // Navigate to Google and perform search
    await page.goto("https://www.google.com", { timeout: 100000 });
    await page.type('input[name="q"], textarea[name="q"]', query);
    await page.keyboard.press("Enter");

    // Wait for search results to load
    await page.waitForSelector("#search", { timeout: 100000 });
    await page.evaluate(
      () => new Promise((resolve) => setTimeout(resolve, 2000))
    );

    // Extract search results
    const searchResults = await page.evaluate(() => {
      const results: { title: string; url: string; snippet: string }[] = [];
      const elements = document.querySelectorAll("#search .g");

      elements.forEach((el) => {
        const titleEl = el.querySelector("h3");
        const linkEl = el.querySelector("a");
        const snippetEl = el.querySelector(".VwiC3b");

        if (titleEl && linkEl && snippetEl) {
          results.push({
            title: titleEl.textContent?.trim() || "",
            url: linkEl.getAttribute("href") || "",
            snippet: snippetEl.textContent?.trim() || "",
          });
        }
      });

      return results;
    });

    // Extract "People also ask" questions and answers
    const peopleAlsoAsk = await page.evaluate(() => {
      const results: { question: string; answer: string }[] = [];
      const elements = document.querySelectorAll(".related-question-pair");

      elements.forEach((el) => {
        const questionEl = el.querySelector(".related-question-pair__question");
        const answerEl = el.querySelector(".related-question-pair__answer");

        if (questionEl && answerEl) {
          results.push({
            question: questionEl.textContent?.trim() || "",
            answer: answerEl.textContent?.trim() || "",
          });
        }
      });

      console.log("peopleAlsoAsk", results);
      return results;
    });

    await browser.close();
    console.log("searchResults", searchResults);
    console.log("peopleAlsoAsk", peopleAlsoAsk);
    return { searchResults, peopleAlsoAsk };
  } catch (error) {
    console.error("Error searching Google:", error);
    throw error;
  }
};

export async function scrapeSearchResults(
  searchResults: SearchResult[],
  productName: string
) {
  const scrapedContents = [];
  const allImages: ProductImage[] = [];

  for (const result of searchResults) {
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const content = await scrapeUrl(result.url, productName);
      if (content.image) {
        allImages.push(content.image);
      }
      const cleanedContent = await cleanContent(content.content);
      scrapedContents.push({
        content: cleanedContent,
      });
    } catch (error) {
      console.error(`Error scraping ${result.url}:`, error);
    }
  }

  return {
    contents: scrapedContents.filter((result) => result.content),
    images: allImages,
  };
}

export async function selectBestImageWithVision(
  images: ProductImage[],
  productName: string,
  openaiReal: any
): Promise<ProductImage | null> {
  if (!images.length) return null;

  try {
    const response = await openaiReal.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are a product image expert. Analyze these product images for "${productName}" and select the best one that represents the product professionally.
              Consider:
              1. Image clarity and quality
              2. Product visibility and focus
              3. Professional product photography
              4. Accurate representation
              5. Marketing appeal
              
              Return ONLY the index number (0-${
                images.length - 1
              }) of the best image.`,
            },
            ...images.map((img) => ({
              type: "image_url" as const,
              image_url: {
                url: img.url,
                detail: "low" as const,
              },
            })),
          ],
        },
      ],
      max_tokens: 50,
    });

    const selectedIndex = parseInt(
      response.choices[0]?.message?.content?.trim() ?? "0"
    );
    if (
      isNaN(selectedIndex) ||
      selectedIndex < 0 ||
      selectedIndex >= images.length
    ) {
      return images[0];
    }

    return images[selectedIndex];
  } catch (error) {
    console.error("Error analyzing images with Vision:", error);
    return images[0];
  }
}

// Add this schema definition after your existing ProductInfoSchema
export const ProductSchema = z.object({
  name: z.string(),
  description: z.string(),
  image: z
    .object({
      url: z.string(),
      alt: z.string(),
    })
    .nullable(),
  ratings: z.number().min(0).max(5),
  reviews: z.array(
    z.object({
      rating: z.number(),
      comment: z.string(),
      author: z.string(),
    })
  ),
  whereToBuy: z.array(
    z.object({
      retailer: z.string(),
      country: z.string(),
      price: z.string(),
      url: z.string(),
    })
  ),
  specifications: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
    })
  ),
  faqs: z.array(
    z.object({
      question: z.string(),
      answer: z.string(),
    })
  ),
});

// Add these helper functions before the route definition
export async function getProductName(extractedData: string) {
  const { object } = await generateObject({
    model: openai("gpt-4o-mini"),
    schema: z.object({
      productName: z.string(),
    }),
    prompt: `Extract the exact product name from this content. Return the whole product name, for example 365 Watt Mono Bifaical Black SL45-60BGI/BHI-365V: ${extractedData}`,
  });
  return object.productName;
}

export async function summarizeContent(content: string) {
  const { text } = await generateText({
    model: openai("gpt-4o-mini"),
    prompt: `
      Analyze this content and extract the following product details:
      1. Technical specifications (key-value pairs like dimensions, weight, power output, etc.)
      2. Pricing information
      3. Reviews and ratings
      4. Key features
      5. Frequently asked questions
      6. Where to buy information if available
      7. Detailed description of the product
      
      Content to analyze: ${content}
      
      Return a structured summary with each detail type seperated from each other.
      Focus on factual information and exclude marketing language.
    `,
  });
  return text;
}
