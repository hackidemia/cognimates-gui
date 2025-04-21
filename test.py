import os
import json
import base64
import requests
import traceback
from flask import Blueprint, request, jsonify

# Create a blueprint for our API endpoints
api = Blueprint('api', __name__)

# --- Helper Functions for Image Generation ---

def create_placeholder_image_base64(text):
    """
    Generate a simple placeholder image with text when the API fails.
    Returns base64 encoded image data.
    """
    try:
        # Import required modules
        from PIL import Image, ImageDraw, ImageFont
        import io
        import base64

        # Create a blank image with a colored background
        width, height = 400, 300
        color = (240, 240, 240)  # Light gray background
        image = Image.new('RGB', (width, height), color)
        draw = ImageDraw.Draw(image)

        # Add a border
        border_color = (200, 200, 200)
        border_width = 2
        for i in range(border_width):
            draw.rectangle(
                (i, i, width - 1 - i, height - 1 - i),
                outline=border_color
            )

        # Add a Cognimates logo/icon at the top
        icon_size = 50
        icon_margin = 20
        icon_color = (66, 133, 244)  # Blue color

        # Draw a simple "C" as a logo
        # Convert list to tuple for ellipse
        draw.ellipse(
            (width // 2 - icon_size // 2, icon_margin,
             width // 2 + icon_size // 2, icon_margin + icon_size),
            outline=icon_color, width=3
        )

        # Convert list to tuple for arc
        draw.arc(
            (width // 2 - icon_size // 4, icon_margin + icon_size // 4,
             width // 2 + icon_size // 4, icon_margin + 3 * icon_size // 4),
            180, 0, fill=icon_color, width=3
        )

        # Prepare to add text
        text_color = (80, 80, 80)  # Dark gray text

        try:
            # Try to use a default system font
            # Note: In many containerized environments, specific fonts may not be available
            title_font = ImageFont.truetype("DejaVuSans.ttf", 20)
            body_font = ImageFont.truetype("DejaVuSans.ttf", 14)
        except Exception:
            # If font file not found, use default
            title_font = ImageFont.load_default()
            body_font = ImageFont.load_default()

        # Add a title
        title = "Image Generation"
        title_y = icon_margin + icon_size + 20

        # Simple measure of text width
        title_w = len(title) * 12
        draw.text(
            (width // 2 - title_w // 2, title_y),
            title,
            font=title_font,
            fill=icon_color
        )

        # Wrap and add the message text
        # Simple word wrapping
        max_chars_per_line = 40
        words = text.split()
        lines = []
        current_line = ""

        for word in words:
            test_line = current_line + " " + word if current_line else word
            if len(test_line) <= max_chars_per_line:
                current_line = test_line
            else:
                lines.append(current_line)
                current_line = word

        if current_line:
            lines.append(current_line)

        # Draw each line of the message
        message_y = title_y + 40
        line_height = 20

        for i, line in enumerate(lines):
            # Center each line
            line_w = len(line) * 7
            line_x = max(20, (width // 2 - line_w // 2))
            draw.text(
                (line_x, message_y + i * line_height),
                line,
                font=body_font,
                fill=text_color
            )

        # Convert the image to base64
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        img_str = base64.b64encode(buffer.getvalue()).decode('utf-8')

        return img_str
    except Exception as e:
        print(f"Error creating placeholder image: {str(e)}")
        # If anything goes wrong, return a simple base64 1x1 pixel
        # This is a transparent 1x1 pixel PNG
        return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

# --- Helper Functions for Prompt Enhancement ---

def get_enhanced_prompt_for_gemini(prompt):
    """
    Enhance the user's prompt for Gemini image generation.
    Simplified for the dedicated image generation model.
    """
    # Simplified prompt for the dedicated image generation model
    return f"""Create a photorealistic, detailed image of: {prompt}

    High resolution with excellent lighting, strong composition, and sharp details.
    Natural environment, realistic proportions. No text, watermarks or signatures.
    """

# --- Image Generation Functions ---

def generate_with_gemini_rest(prompt, api_key):
    """
    Generate images using the Google AI Gemini REST API.
    Returns a list of base64 encoded images on success, None on failure.
    """
    print("Attempting image generation with Google Gemini REST API")
    # Use the appropriate Gemini model that can handle image generation requests
    model = "gemini-2.0-flash-exp-image-generation"  # Specific image generation model
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

    enhanced_prompt = get_enhanced_prompt_for_gemini(prompt)

    headers = {
        "Content-Type": "application/json"
    }

    # Construct the request body for the Gemini API based on the working example
    request_body = {
        "contents": [
            {
                "parts": [
                    {"text": enhanced_prompt}
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.8,
            "topP": 0.95,
            "topK": 40,
            "candidateCount": 1,
            "stopSequences": [],
            "maxOutputTokens": 8192
        },
        "systemInstruction": {
            "parts": [
                {"text": "You are a powerful image generation model. Generate high-quality images based on user prompts. Do not generate text responses, only create images."}
            ]
        }
    }

    print(f"Making Gemini REST API request to: models/{model}")

    try:
        response = requests.post(url, headers=headers, json=request_body, timeout=120)
        print(f"Gemini REST API response status code: {response.status_code}")

        if response.status_code != 200:
            print(f"Error response from Gemini REST API: {response.text[:500]}...")
            # Log specific error details if available in response JSON
            try:
                error_details = response.json()
                print(f"Error details: {json.dumps(error_details, indent=2)}")
            except json.JSONDecodeError:
                pass  # Ignore if response is not JSON
            return None  # Indicate failure

        # Parse response JSON
        result = response.json()
        print("Successfully received response from Gemini REST API")

        # Process the Gemini API response to extract image data
        image_data_list = []
        if 'candidates' in result and isinstance(result['candidates'], list) and len(result['candidates']) > 0:
            # Check the first candidate (usually the only one unless candidateCount > 1)
            candidate = result['candidates'][0]
            if 'content' in candidate and 'parts' in candidate['content'] and isinstance(candidate['content']['parts'], list):
                for part in candidate['content']['parts']:
                    # Look for inlineData which typically holds base64 blobs
                    if 'inlineData' in part and isinstance(part['