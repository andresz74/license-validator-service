# license-validator-service
---

# License Validator

## About

License Validator is a simple Node.js application built with Express.js. It provides an API endpoint to validate license keys against a predefined list of valid licenses. This project is useful for software that requires license key validation.

## Features

- Validate license keys via an API endpoint.
- Easy integration with existing systems.
- Simple and straightforward setup.

## Getting Started

### Prerequisites

- Node.js
- npm (Node Package Manager)

### Installation

1. **Clone the Repository**
    ```bash
    git clone https://github.com/andresz74/license-validator-main.git
    cd license-validator-main
    ```

2. **Install Dependencies**
    ```bash
    npm install
    ```

3. **Set Up License Keys**
    - Create a `licenses.json` file in the root directory.
    - Add an array of valid license keys. Example:
        ```json
        ["key1", "key2", "key3"]
        ```

### Running the Application

1. **Start the Server**
    ```bash
    npm start
    ```
    The server will start on `http://localhost:3000`.

2. **Access the Endpoint**
    - Validate a license key by navigating to `http://localhost:3000/validate-license?key=your_license_key`.

## API Reference

### Validate License Endpoint

- **URL**
  
  `/validate-license`

- **Method:**
  
  `GET`
  
- **URL Params**

   **Required:**
 
   `key=[string]`

- **Success Response:**

  - **Code:** 200 <br />
    **Content:** `OK`
 
- **Error Response:**

  - **Code:** 401 UNAUTHORIZED <br />
    **Content:** `KO`

## Contributing

Contributions to the License Validator project are welcome!

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

Distributed under the MIT License. See `LICENSE` file for more information.

## Contact

Andres Zenteno - [andres@zenteno.org](mailto:andres@zenteno.org)

Project Link: [https://github.com/andresz74/license-validator-main](https://github.com/andresz74/license-validator-main)
