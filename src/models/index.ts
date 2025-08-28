// import fs from "fs";
// import path from "path";
// import { Sequelize, DataTypes, Model, ModelStatic } from "sequelize";
// import process from "process";
// import dotenv from "dotenv";
// import { fileURLToPath } from "url";
// import { createRequire } from "module";

// dotenv.config();

// // --- FIX for ES Modules ---
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);
// const require = createRequire(import.meta.url);

// const basename = path.basename(__filename);

// // --- FIX for TypeScript Error ---
// // We define an interface specifically for the models collection.
// // This uses an index signature to allow for dynamic model names (e.g., 'syncing_db').
// interface DbModels {
//   [key: string]: ModelStatic<Model<any, any>>;
// }

// // To solve the error "Property 'sequelize' is not assignable to string index type",
// // we change `DB` from an interface to a type alias. We use an intersection type (`&`)
// // to combine our dynamic models (`DbModels`) with the specific `sequelize` and `Sequelize`
// // properties. This tells TypeScript that an object of type `DB` will have a collection
// // of models AND the two specific sequelize properties, resolving the type conflict.
// export type DB = DbModels & {
//   sequelize: Sequelize;
//   Sequelize: typeof Sequelize;
// };

// // We can start by typing `db` as a partial object that will eventually
// // conform to the full DB type.
// const db: Partial<DB> = {};

// const sequelize = new Sequelize(
//   process.env.DATABASE as string,
//   process.env.DB_USERNAME as string,
//   process.env.DB_PASSWORD,
//   {
//     dialect: "postgres",
//     host: process.env.DB_HOST,
//     logging: false,
//   }
// );

// fs.readdirSync(__dirname)
//   .filter((file) => {
//     return (
//       file.indexOf(".") !== 0 &&
//       file !== basename &&
//       file.slice(-3) === ".ts" &&
//       file.indexOf(".test.ts") === -1
//     );
//   })
//   .forEach((file) => {
//     // We use the 'require' we created above to load the model files
//     const modelModule = require(path.join(__dirname, file));
//     const model = modelModule.default(sequelize, DataTypes);
//     // Here, we are adding models to the db object.
//     // TypeScript understands this is compatible with the DbModels index signature.
//     db[model.name] = model;
//   });

// Object.keys(db).forEach((modelName) => {
//   // We need to be careful with types here since db is still Partial<DB>
//   const model = db[modelName];
//   // Check if the associate function exists before calling it
//   if (model && "associate" in model && typeof model.associate === "function") {
//     // Pass the db object to the association functions.
//     // We cast it to the full DB type because we know it will have all
//     // the models by this point, which is what 'associate' needs.
//     model.associate(db as DB);
//   }
// });

// // Add the sequelize instance and class to the db object
// db.sequelize = sequelize;
// db.Sequelize = Sequelize;

// // Sync all models
// sequelize.sync();

// // Finally, we export the fully constructed db object, casting it to DB
// // so that other files importing it get the correct, full type.
// export default db as DB;
