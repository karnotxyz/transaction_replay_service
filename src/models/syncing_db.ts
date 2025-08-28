// import { Model, DataTypes, Sequelize } from "sequelize";

// export default (sequelize: Sequelize) => {
//   class SyncingDb extends Model {
//     public id!: number;
//     public attribute!: string;
//     public value!: number;

//     static associate(models: any) {
//       // define association here
//     }
//   }

//   SyncingDb.init(
//     {
//       attribute: {
//         type: DataTypes.STRING,
//         allowNull: false,
//       },
//       value: {
//         type: DataTypes.INTEGER,
//         allowNull: false,
//       },
//     },
//     {
//       sequelize,
//       modelName: "syncing_db",
//       tableName: "syncing_db",
//     }
//   );

//   return SyncingDb;
// };
